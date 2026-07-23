/**
 * Shared council engine. Milestone 1 implements `review` mode end to end;
 * ensemble modes (best/fusion/compare) plug into the same executor shape later.
 *
 * The merge is DETERMINISTIC — no judge model, no weighted voting (deferred by
 * the implementation brief until a benchmark proves incremental value).
 * Minority findings are preserved verbatim: every ok reviewer's findings land
 * in the verdict regardless of the merged status.
 *
 * Transport hygiene: prompts bound for external (non-local) reviewers are
 * secret-redacted before they leave the process, and every external call —
 * attempt, failure, or repair retry — is budget-reserved BEFORE dispatch.
 */
import { GENERIC_REVIEW_SYSTEM_PROMPT, boundReviewRequest, buildReviewPrompt, parseReviewResponse } from "./domain/generic.js";
import { buildCandidatePrompt, CANDIDATE_SYSTEM_PROMPT } from "./candidates.js";
import {
  anonymizeCandidates,
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeResponse,
  selectWinner,
  type ScoredCandidate,
} from "./judge.js";
import { buildFusionPrompt, FUSION_SYSTEM_PROMPT, parseFusionPlan } from "./fusion.js";
import type { BudgetCoordinator, BudgetDecision, ResolveVectorConfig, ReviewerConfig } from "./policy.js";
import { checkExternalBudget, effectiveScope, reviewerDeadlines } from "./policy.js";
import type { CompleteCallOptions, ResolveResult, ResolvedReviewer, ReviewerOutput } from "./providers.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";
import { CIRCUIT_OPENING_CATEGORIES, ReviewerCallError, type FailureCategory } from "./stream-guard.js";
import type { CandidateReceipt, CheckReceipt, CouncilVerdict, EvidenceItem, Finding, ReviewerReceipt, VerdictStatus } from "./receipts.js";
import { newReceiptId, redactSecrets } from "./receipts.js";

/** Visible progress events; the runtime wires these to ctx.ui notifications. */
export type CouncilProgressEvent =
  | { type: "council_started"; reviewerIds: string[] }
  | { type: "reviewer_unavailable"; reviewerId: string; detail: string; remaining: string[] }
  | { type: "reviewer_skipped"; reviewerId: string; detail: string };

export interface CouncilDeps {
  resolveReviewer: (config: ReviewerConfig) => Promise<ResolveResult>;
  complete: (
    resolved: ResolvedReviewer,
    systemPrompt: string,
    userPrompt: string,
    options?: CompleteCallOptions,
  ) => Promise<ReviewerOutput>;
  now?: () => number;
  /** Parent cancellation signal, wired to every reviewer call. */
  signal?: AbortSignal;
  /** Per-reviewer circuit breaker; open seats are skipped before dispatch. */
  circuit?: CircuitBreakerRegistry;
  /** Progress notifications (started / unavailable / skipped). */
  onProgress?: (event: CouncilProgressEvent) => void;
  /** Atomic budget reservations. Takes precedence over externalTimestamps. */
  budget?: BudgetCoordinator;
  /** Legacy fallback: past external-call timestamps for non-atomic budget checks. */
  externalTimestamps?: readonly number[];
}

export interface RunCouncilInput {
  goal: string;
  proposal: string;
  evidence?: EvidenceItem[];
  constraints?: string[];
  /** Live family token of the model whose work is under review. */
  primaryFamily?: string;
  config: ResolveVectorConfig;
  deps: CouncilDeps;
}

const STATUS_SEVERITY: Record<VerdictStatus, number> = {
  fail: 5,
  concern: 4,
  split: 3,
  insufficient_evidence: 2,
  pass: 1,
  review_unavailable: 0,
};

/** Deterministic status merge. Material pass-vs-fail disagreement → split. */
export function mergeStatuses(statuses: readonly VerdictStatus[]): VerdictStatus {
  if (statuses.length === 0) return "review_unavailable";
  if (statuses.length > 1 && statuses.includes("pass") && statuses.includes("fail")) return "split";
  let worst: VerdictStatus = "pass";
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

function skippedReceipt(config: ReviewerConfig, status: ReviewerReceipt["status"], detail: string): ReviewerReceipt {
  return {
    reviewerId: config.id,
    provider: config.provider,
    model: config.model,
    family: config.family,
    local: config.local,
    status,
    calls: 0,
    findings: [],
    latencyMs: 0,
    skipped: true,
    error: detail,
  };
}

async function reviewWith(
  resolved: ResolvedReviewer,
  input: RunCouncilInput,
  deps: CouncilDeps,
  reserveExternal: () => BudgetDecision | Promise<BudgetDecision>,
): Promise<ReviewerReceipt> {
  const started = (deps.now ?? Date.now)();
  const base = {
    reviewerId: resolved.config.id,
    provider: resolved.model.provider,
    model: resolved.model.id,
    family: resolved.family,
    local: resolved.config.local,
  };
  // Bound the review context: only the goal, answer, evidence, and
  // constraints go out — never the whole OMP conversation — and oversized
  // inputs are truncated with explicit receipt metadata.
  const bounded = boundReviewRequest(
    { goal: input.goal, proposal: input.proposal, evidence: input.evidence, constraints: input.constraints },
    input.config.maxReviewInputChars,
  );
  const deadlines = reviewerDeadlines(resolved.config, input.config);
  const callOptions: CompleteCallOptions = {
    signal: deps.signal,
    deadlines,
    maxTokens: input.config.maxReviewOutputTokens,
  };
  // Privacy: secrets are redacted before external transport UNLESS the seat
  // is explicitly external-allowed. Local seats never leave the machine.
  const scope = effectiveScope(resolved.config);
  const rawPrompt = buildReviewPrompt(bounded.request);
  const transportPrompt = resolved.config.local || scope === "external-allowed" ? rawPrompt : redactSecrets(rawPrompt);
  let calls = 0;
  // Every external call — the initial attempt included — is budget-reserved
  // BEFORE dispatch.
  if (!resolved.config.local) {
    const initial = await reserveExternal();
    if (!initial.allowed) {
      return {
        ...base,
        status: "skipped_budget",
        calls: 0,
        findings: [],
        latencyMs: 0,
        skipped: true,
        error: initial.reason ?? "budget reached",
      };
    }
  }
  try {
    calls += 1;
    const output = await deps.complete(resolved, GENERIC_REVIEW_SYSTEM_PROMPT, transportPrompt, callOptions);
    const latencyMs = (deps.now ?? Date.now)() - started;
    try {
      const parsed = parseReviewResponse(output.text);
      return {
        ...base,
        status: "ok",
        calls,
        verdict: parsed.status,
        summary: parsed.summary,
        findings: parsed.findings,
        latencyMs,
        connectLatencyMs: output.metrics?.connectLatencyMs,
        firstTokenLatencyMs: output.metrics?.firstTokenLatencyMs,
        inputTruncated: bounded.truncated || undefined,
        usage: output.usage,
      };
    } catch (parseError) {
      // One repair retry (proven in the legacy panel-review experiment): resend
      // the ORIGINAL request plus the bad output, demand bare JSON. Fail closed
      // if it still does not comply — never treat prose as a pass. Repair only
      // ever follows a SUCCESSFUL call; transport timeouts never reach here.
      if (!resolved.config.local) {
        const repairBudget = await reserveExternal();
        if (!repairBudget.allowed) {
          return {
            ...base,
            status: "error",
            calls,
            findings: [],
            latencyMs,
            usage: output.usage,
            error: `unparseable verdict: ${(parseError as Error).message}; repair skipped — ${repairBudget.reason}`,
          };
        }
      }
      calls += 1;
      const repaired = await deps.complete(
        resolved,
        GENERIC_REVIEW_SYSTEM_PROMPT,
        `## Original review request\n${transportPrompt}\n\n## Your previous response (not a valid JSON verdict, truncated)\n${output.text.slice(0, 500)}\n\nRespond to the original request with ONLY the JSON verdict object now.`,
        callOptions,
      );
      const repairLatency = (deps.now ?? Date.now)() - started;
      try {
        const parsed = parseReviewResponse(repaired.text);
        return {
          ...base,
          status: "ok",
          calls,
          verdict: parsed.status,
          summary: parsed.summary,
          findings: parsed.findings,
          latencyMs: repairLatency,
          connectLatencyMs: repaired.metrics?.connectLatencyMs ?? output.metrics?.connectLatencyMs,
          firstTokenLatencyMs: repaired.metrics?.firstTokenLatencyMs ?? output.metrics?.firstTokenLatencyMs,
          inputTruncated: bounded.truncated || undefined,
          usage: {
            input: (output.usage?.input ?? 0) + (repaired.usage?.input ?? 0),
            output: (output.usage?.output ?? 0) + (repaired.usage?.output ?? 0),
          },
        };
      } catch (repairError) {
        return {
          ...base,
          status: "error",
          calls,
          findings: [],
          latencyMs: repairLatency,
          usage: {
            input: (output.usage?.input ?? 0) + (repaired.usage?.input ?? 0),
            output: (output.usage?.output ?? 0) + (repaired.usage?.output ?? 0),
          },
          error: `unparseable verdict after repair: ${(repairError as Error).message}; raw output began: ${JSON.stringify(output.text.slice(0, 200))}`,
        };
      }
    }
  } catch (error) {
    const latencyMs = (deps.now ?? Date.now)() - started;
    if (error instanceof ReviewerCallError) {
      // Typed transport failure: no retry, no repair — the council continues
      // immediately with healthy reviewers.
      const status =
        error.category === "timeout_first_token"
          ? ("timeout_first_token" as const)
          : error.category === "timeout_connect" || error.category === "timeout_total"
            ? ("timeout" as const)
            : ("error" as const);
      return {
        ...base,
        status,
        calls,
        findings: [],
        latencyMs,
        connectLatencyMs: error.metrics?.connectLatencyMs,
        firstTokenLatencyMs: error.metrics?.firstTokenLatencyMs,
        failureCategory: error.category,
        inputTruncated: bounded.truncated || undefined,
        error: error.message,
      };
    }
    const message = (error as Error).message;
    const isTimeout = /timed?\s*out|timeout|aborted/i.test(message) || (error as Error).name === "TimeoutError";
    return {
      ...base,
      status: isTimeout ? "timeout" : "error",
      calls,
      findings: [],
      latencyMs,
      inputTruncated: bounded.truncated || undefined,
      error: message,
    };
  }
}

/** Minimal concurrency limiter — preserves input order in the output. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface PreparedSeats {
  runnable: ResolvedReviewer[];
  receipts: ReviewerReceipt[];
}

/**
 * Shared seat preparation for all council modes: eligibility, resolution,
 * and cross-family enforcement. Budget is NOT touched here — reservations
 * happen per CALL at dispatch time, so seats that never fire cost nothing.
 */
async function prepareSeats(
  config: ResolveVectorConfig,
  deps: CouncilDeps,
  primaryFamily: string | undefined,
): Promise<PreparedSeats> {
  const receipts: ReviewerReceipt[] = [];
  const eligible: ReviewerConfig[] = [];
  for (const reviewer of config.reviewers) {
    if (!reviewer.enabled) continue;
    if (reviewer.trigger === "escalation") continue; // escalation seats stay cold until M4
    eligible.push(reviewer);
  }

  const resolved = await mapLimited(eligible, config.maxConcurrentReviewers, (reviewer) => deps.resolveReviewer(reviewer));

  const runnable: ResolvedReviewer[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const result: ResolveResult = resolved[i];
    const reviewerConfig = eligible[i];
    if (!result.ok) {
      receipts.push(skippedReceipt(reviewerConfig, "error", result.detail));
      continue;
    }
    if (primaryFamily && result.reviewer.family === primaryFamily) {
      receipts.push(
        skippedReceipt(
          reviewerConfig,
          "skipped_same_family",
          `same model family as the primary (${result.reviewer.family}); cross-family review required`,
        ),
      );
      continue;
    }
    // Privacy policy: a local-only seat that is external never receives content.
    if (!reviewerConfig.local && effectiveScope(reviewerConfig) === "local-only") {
      receipts.push(
        skippedReceipt(
          reviewerConfig,
          "skipped_policy",
          "scope is local-only but the seat is external; content never leaves the machine by policy",
        ),
      );
      continue;
    }
    // Circuit breaker: a seat whose generation timed out or broke transport
    // recently stays skipped for its cooldown — no more waiting on dead seats.
    const circuitBlock = deps.circuit?.check(reviewerConfig.id);
    if (circuitBlock) {
      receipts.push({
        ...skippedReceipt(
          reviewerConfig,
          "skipped_circuit_open",
          `circuit open (${circuitBlock.reason}) — retry in ${Math.ceil(circuitBlock.remainingMs / 1000)}s, or /rv reviewer retry ${reviewerConfig.id}`,
        ),
        circuitState: "open",
        failureCategory: circuitBlock.reason,
      });
      deps.onProgress?.({
        type: "reviewer_skipped",
        reviewerId: reviewerConfig.id,
        detail: `circuit open (${circuitBlock.reason}), ${Math.ceil(circuitBlock.remainingMs / 1000)}s remaining`,
      });
      continue;
    }
    runnable.push(result.reviewer);
  }
  return { runnable, receipts };
}

/** Per-call budget reservation closure (reservations are global, not per-seat). */
function reserveFor(config: ResolveVectorConfig, deps: CouncilDeps): () => BudgetDecision | Promise<BudgetDecision> {
  const now = deps.now ?? Date.now;
  return () =>
    deps.budget
      ? deps.budget.tryReserve(now())
      : checkExternalBudget(config, deps.externalTimestamps ?? [], now());
}

export async function runCouncil(input: RunCouncilInput): Promise<CouncilVerdict> {
  const { config, deps } = input;
  const now = deps.now ?? Date.now;
  const startedAt = now();

  const seats = await prepareSeats(config, deps, input.primaryFamily);
  const receipts: ReviewerReceipt[] = [...seats.receipts];

  deps.onProgress?.({ type: "council_started", reviewerIds: seats.runnable.map((r) => r.config.id) });
  const inFlight = new Set(seats.runnable.map((r) => r.config.id));

  const runReceipts = await mapLimited(seats.runnable, config.maxConcurrentReviewers, async (reviewer) => {
    const id = reviewer.config.id;
    const receipt = await reviewWith(reviewer, input, deps, reserveFor(config, deps));
    inFlight.delete(id);
    // Circuit bookkeeping + immediate visibility. A failed seat NEVER blocks
    // a healthy seat's verdict — the user hears about degradation as it
    // happens, not after the total timeout.
    if (deps.circuit) {
      if (receipt.status === "ok") {
        deps.circuit.recordSuccess(id);
      } else if (receipt.failureCategory && CIRCUIT_OPENING_CATEGORIES[receipt.failureCategory as FailureCategory]) {
        deps.circuit.recordFailure(id, receipt.failureCategory as FailureCategory);
      }
      receipt.circuitState = deps.circuit.snapshot(id).state;
    }
    if (receipt.status !== "ok") {
      deps.onProgress?.({
        type: "reviewer_unavailable",
        reviewerId: id,
        detail: receipt.error ?? receipt.status,
        remaining: [...inFlight],
      });
    }
    return receipt;
  });
  receipts.push(...runReceipts);

  const okReceipts = receipts.filter((r) => r.status === "ok" && r.verdict);
  const status = mergeStatuses(okReceipts.map((r) => r.verdict as VerdictStatus));
  const findings = okReceipts.flatMap((r) => r.findings);
  // Coverage is degraded when an enabled seat failed or was circuit-skipped
  // while at least one reviewer succeeded. Policy skips (same-family,
  // budget, local-only) are by-design, not degradation.
  const degradedBy = receipts.filter(
    (r) => r.status === "error" || r.status === "timeout" || r.status === "timeout_first_token" || r.status === "skipped_circuit_open",
  );
  const coverageDegraded = okReceipts.length > 0 && degradedBy.length > 0;
  const summary =
    okReceipts.length === 0
      ? "No reviewer completed; review unavailable."
      : `${okReceipts.map((r) => `${r.reviewerId}: ${r.summary ?? r.verdict}`).join(" | ")}${
          coverageDegraded
            ? ` — reduced coverage (${degradedBy.map((r) => `${r.reviewerId}: ${r.status}`).join(", ")})`
            : ""
        }`;

  return {
    id: newReceiptId(startedAt),
    mode: "review",
    status,
    summary,
    findings,
    reviewers: receipts,
    deterministicChecks: [],
    usage: {
      input: okReceipts.reduce((sum, r) => sum + (r.usage?.input ?? 0), 0),
      output: okReceipts.reduce((sum, r) => sum + (r.usage?.output ?? 0), 0),
      totalLatencyMs: now() - startedAt,
    },
    coverageDegraded: coverageDegraded || undefined,
    createdAt: new Date(startedAt).toISOString(),
  };
}

/* ──────────────────────────── ensemble modes ──────────────────────────── */

export interface RunEnsembleInput {
  mode: "best" | "fusion" | "compare";
  goal: string;
  constraints?: string[];
  evidence?: EvidenceItem[];
  candidateCount: number;
  /** Live family token of the primary model; same-family seats are skipped. */
  primaryFamily?: string;
  config: ResolveVectorConfig;
  deps: EnsembleDeps;
}

export interface EnsembleDeps extends CouncilDeps {
  /** Injected for tests: drives anonymization shuffling. */
  rng?: () => number;
  /** Objective pre-judge checks; a failure disqualifies the candidate. */
  checks?: (candidate: { anonId: string; text: string }) => CheckReceipt[];
}

class BudgetExceeded extends Error {}

/** One transport call for generation/judge/fusion, with redaction + receipt. */
async function callSeat(
  seat: ResolvedReviewer,
  systemPrompt: string,
  rawPrompt: string,
  deps: CouncilDeps,
  reserve: () => BudgetDecision | Promise<BudgetDecision>,
  started: () => number,
  callOptions: CompleteCallOptions,
): Promise<{ output?: ReviewerOutput; receipt: ReviewerReceipt }> {
  const base = {
    reviewerId: seat.config.id,
    provider: seat.model.provider,
    model: seat.model.id,
    family: seat.family,
    local: seat.config.local,
  };
  if (!seat.config.local) {
    const decision = await reserve();
    if (!decision.allowed) throw new BudgetExceeded(decision.reason ?? "budget reached");
  }
  const prompt = seat.config.local || effectiveScope(seat.config) === "external-allowed" ? rawPrompt : redactSecrets(rawPrompt);
  const t0 = started();
  try {
    const output = await deps.complete(seat, systemPrompt, prompt, callOptions);
    deps.circuit?.recordSuccess(seat.config.id);
    return {
      output,
      receipt: {
        ...base,
        status: "ok",
        calls: 1,
        findings: [],
        latencyMs: started() - t0,
        connectLatencyMs: output.metrics?.connectLatencyMs,
        firstTokenLatencyMs: output.metrics?.firstTokenLatencyMs,
        circuitState: deps.circuit?.snapshot(seat.config.id).state,
        usage: output.usage,
      },
    };
  } catch (error) {
    if (error instanceof ReviewerCallError) {
      if (deps.circuit && CIRCUIT_OPENING_CATEGORIES[error.category]) {
        deps.circuit.recordFailure(seat.config.id, error.category);
      }
      return {
        receipt: {
          ...base,
          status: error.category === "timeout_first_token" ? "timeout_first_token" : error.category.startsWith("timeout") ? "timeout" : "error",
          calls: 1,
          findings: [],
          latencyMs: started() - t0,
          connectLatencyMs: error.metrics?.connectLatencyMs,
          firstTokenLatencyMs: error.metrics?.firstTokenLatencyMs,
          failureCategory: error.category,
          circuitState: deps.circuit?.snapshot(seat.config.id).state,
          error: error.message,
        },
      };
    }
    const message = (error as Error).message;
    const isTimeout = /timed?\s*out|timeout|aborted/i.test(message) || (error as Error).name === "TimeoutError";
    return {
      receipt: {
        ...base,
        status: isTimeout ? "timeout" : "error",
        calls: 1,
        findings: [],
        latencyMs: started() - t0,
        error: message,
      },
    };
  }
}

/** Role-preferred seat picker; falls back to the first runnable seat. */
function pickSeat(runnable: readonly ResolvedReviewer[], roles: readonly string[]): ResolvedReviewer | undefined {
  for (const role of roles) {
    const seat = runnable.find((r) => r.config.role === role);
    if (seat) return seat;
  }
  return runnable[0];
}

function ensembleUsage(receipts: readonly (ReviewerReceipt | CandidateReceipt)[], totalLatencyMs: number) {
  return {
    input: receipts.reduce((sum, r) => sum + (r.usage?.input ?? 0), 0),
    output: receipts.reduce((sum, r) => sum + (r.usage?.output ?? 0), 0),
    totalLatencyMs,
  };
}

export async function runEnsemble(input: RunEnsembleInput): Promise<CouncilVerdict> {
  const { config, deps } = input;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const rng = deps.rng ?? Math.random;
  const reviewerReceipts: ReviewerReceipt[] = [];
  const candidateReceipts: CandidateReceipt[] = [];
  const allChecks: CheckReceipt[] = [];

  const unavailable = (summary: string): CouncilVerdict => ({
    id: newReceiptId(startedAt),
    mode: input.mode,
    status: "review_unavailable",
    summary,
    findings: [],
    reviewers: reviewerReceipts,
    candidates: candidateReceipts,
    deterministicChecks: allChecks,
    usage: ensembleUsage([...reviewerReceipts, ...candidateReceipts], now() - startedAt),
    createdAt: new Date(startedAt).toISOString(),
  });

  // 1. Seats: resolution + cross-family + budget, shared with review mode.
  const seats = await prepareSeats(config, deps, input.primaryFamily);
  reviewerReceipts.push(...seats.receipts);
  const generators = seats.runnable.slice(0, input.candidateCount);
  if (generators.length < 2) {
    return unavailable(`ensemble needs at least 2 runnable generator seats; got ${generators.length}`);
  }

  try {
    // 2. Independent generation (isolated prompts — no cross-anchoring).
    const generated = await mapLimited(generators, config.maxConcurrentReviewers, async (seat) => {
      const t0 = now();
      const prompt = buildCandidatePrompt(input);
      const { output, receipt } = await callSeat(
        seat,
        CANDIDATE_SYSTEM_PROMPT,
        prompt,
        deps,
        reserveFor(config, deps),
        now,
        { signal: deps.signal, deadlines: reviewerDeadlines(seat.config, config), maxTokens: config.maxReviewOutputTokens },
      );
      const candidate: CandidateReceipt = { ...receipt, anonId: "", latencyMs: now() - t0 };
      candidateReceipts.push(candidate);
      return output ? { seatId: seat.config.id, text: output.text, receipt: candidate } : undefined;
    });
    const okCandidates = generated.filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (okCandidates.length < 2) {
      return unavailable(`ensemble needs at least 2 generated candidates; got ${okCandidates.length}`);
    }

    // 3. Anonymize + shuffle; the judge never sees seat identity.
    const anon = anonymizeCandidates(
      okCandidates.map((c) => ({ seatId: c.seatId, text: c.text })),
      rng,
    );
    for (const candidate of anon) {
      const receipt = okCandidates.find((c) => c.seatId === candidate.seatId)?.receipt;
      if (receipt) receipt.anonId = candidate.anonId;
    }

    // 4. Deterministic checks BEFORE judging; failures disqualify.
    const checksByAnon = new Map<string, CheckReceipt[]>();
    for (const candidate of anon) {
      const checks = deps.checks?.(candidate) ?? [];
      checksByAnon.set(candidate.anonId, checks);
      for (const check of checks) allChecks.push({ ...check, name: `${candidate.anonId}:${check.name}` });
      const disqualified = checks.some((check) => !check.passed);
      const receipt = candidateReceipts.find((r) => r.anonId === candidate.anonId);
      if (receipt) receipt.disqualified = disqualified;
    }

    // 5. Blind judging (also used by compare).
    const judgeSeat = pickSeat(seats.runnable, ["judge"]);
    if (!judgeSeat) return unavailable("no runnable seat available for judging");
    const judgeCall = await callSeat(
      judgeSeat,
      JUDGE_SYSTEM_PROMPT,
      buildJudgePrompt(input.goal, input.constraints, anon),
      deps,
      reserveFor(config, deps),
      now,
      { signal: deps.signal, deadlines: reviewerDeadlines(judgeSeat.config, config), maxTokens: config.maxReviewOutputTokens },
    );
    reviewerReceipts.push(judgeCall.receipt);
    if (!judgeCall.output) return unavailable(`judge call failed: ${judgeCall.receipt.error ?? "unknown"}`);
    const judgeScores = parseJudgeResponse(judgeCall.output.text);

    const scored: ScoredCandidate[] = anon.map((candidate) => {
      const entry = judgeScores.find((s) => s.candidate === candidate.anonId);
      const checks = checksByAnon.get(candidate.anonId) ?? [];
      const disqualified = checks.some((check) => !check.passed);
      const total = entry
        ? Object.values(entry.scores).reduce((sum, value) => sum + value, 0)
        : 0;
      const receipt = candidateReceipts.find((r) => r.anonId === candidate.anonId);
      if (receipt) receipt.total = total;
      return {
        anonId: candidate.anonId,
        seatId: candidate.seatId,
        scores: entry?.scores ?? { intent: 0, correctness: 0, completeness: 0, evidence: 0, reasoning: 0, constraints: 0, practicality: 0 },
        total,
        note: entry?.note ?? (entry ? undefined : "not scored by judge"),
        checks,
        disqualified,
      };
    });

    const findings: Finding[] = scored.flatMap((candidate) => {
      const entries: Finding[] = candidate.checks
        .filter((check) => !check.passed)
        .map((check) => ({
          severity: "high" as const,
          category: "constraint" as const,
          claim: `${candidate.anonId} failed objective check ${check.name}`,
          concern: check.detail ?? "deterministic check failed",
          evidence: [],
        }));
      if (candidate.note) {
        entries.push({
          severity: "info" as const,
          category: "other" as const,
          claim: `${candidate.anonId} (total ${candidate.total}/35${candidate.disqualified ? ", disqualified" : ""})`,
          concern: candidate.note,
          evidence: [],
        });
      }
      return entries;
    });

    if (input.mode === "compare") {
      // Compare never selects: alternatives + tradeoffs, decision stays human.
      const anyQualified = scored.some((candidate) => !candidate.disqualified);
      return {
        id: newReceiptId(startedAt),
        mode: "compare",
        status: anyQualified ? "pass" : "fail",
        summary: scored
          .map((candidate) => `${candidate.anonId}: ${candidate.total}/35${candidate.disqualified ? " (disqualified)" : ""} — ${candidate.note ?? "no note"}`)
          .join(" | "),
        findings,
        reviewers: reviewerReceipts,
        candidates: candidateReceipts,
        deterministicChecks: allChecks,
        usage: ensembleUsage([...reviewerReceipts, ...candidateReceipts], now() - startedAt),
        createdAt: new Date(startedAt).toISOString(),
      };
    }

    if (input.mode === "best") {
      const outcome = selectWinner(scored);
      const status: VerdictStatus =
        outcome.outcome === "winner" ? "pass" : outcome.outcome === "split" ? "split" : "fail";
      const winner = outcome.outcome === "winner" ? anon.find((c) => c.anonId === outcome.anonId) : undefined;
      return {
        id: newReceiptId(startedAt),
        mode: "best",
        status,
        summary:
          outcome.outcome === "winner"
            ? `best-of-${anon.length}: ${outcome.anonId} wins (${scored.find((s) => s.anonId === outcome.anonId)?.total}/35)`
            : outcome.outcome === "split"
              ? `best-of-${anon.length}: tie for first — human tiebreak needed`
              : `best-of-${anon.length}: every candidate failed objective checks`,
        findings,
        selectedCandidateId: outcome.outcome === "winner" ? outcome.anonId : undefined,
        finalAnswer: winner?.text,
        reviewers: reviewerReceipts,
        candidates: candidateReceipts,
        deterministicChecks: allChecks,
        usage: ensembleUsage([...reviewerReceipts, ...candidateReceipts], now() - startedAt),
        createdAt: new Date(startedAt).toISOString(),
      };
    }

    // 6. Fusion: conflict-aware synthesis, then one final independent review.
    const fusionSeat = pickSeat(seats.runnable, ["fusion", "judge"]);
    if (!fusionSeat) return unavailable("no runnable seat available for fusion");
    const fusionCall = await callSeat(
      fusionSeat,
      FUSION_SYSTEM_PROMPT,
      buildFusionPrompt(input.goal, input.constraints, anon),
      deps,
      reserveFor(config, deps),
      now,
      { signal: deps.signal, deadlines: reviewerDeadlines(fusionSeat.config, config), maxTokens: config.maxReviewOutputTokens },
    );
    reviewerReceipts.push(fusionCall.receipt);
    if (!fusionCall.output) return unavailable(`fusion call failed: ${fusionCall.receipt.error ?? "unknown"}`);
    const plan = parseFusionPlan(fusionCall.output.text);

    for (const conflict of plan.unresolved) {
      findings.push({
        severity: "medium",
        category: "other",
        claim: `unresolved conflict: ${conflict.topic}`,
        concern: conflict.positions.map((p) => `${p.candidate}: ${p.claim}`).join(" vs "),
        evidence: [],
      });
    }

    const reviewSeat = pickSeat(seats.runnable, ["verifier", "method"]) ?? fusionSeat;
    const reviewReceipt = await reviewWith(
      reviewSeat,
      {
        goal: input.goal,
        proposal: plan.finalAnswer,
        constraints: input.constraints,
        evidence: input.evidence,
        config,
        deps,
      },
      deps,
      reserveFor(config, deps),
    );
    reviewerReceipts.push(reviewReceipt);
    const reviewFindings = reviewReceipt.findings;
    const status: VerdictStatus =
      reviewReceipt.status !== "ok"
        ? "insufficient_evidence"
        : ((reviewReceipt.verdict ?? "insufficient_evidence") as VerdictStatus);

    return {
      id: newReceiptId(startedAt),
      mode: "fusion",
      status,
      summary: `fusion of ${anon.length}: ${plan.agreements.length} agreements, ${plan.selectedClaims.length} resolved, ${plan.unresolved.length} unresolved · final review: ${status}`,
      findings: [...findings, ...reviewFindings],
      finalAnswer: plan.finalAnswer,
      reviewers: reviewerReceipts,
      candidates: candidateReceipts,
      deterministicChecks: allChecks,
      usage: ensembleUsage([...reviewerReceipts, ...candidateReceipts], now() - startedAt),
      createdAt: new Date(startedAt).toISOString(),
    };
  } catch (error) {
    if (error instanceof BudgetExceeded) {
      return unavailable(`external budget exhausted mid-ensemble: ${error.message}`);
    }
    throw error;
  }
}
