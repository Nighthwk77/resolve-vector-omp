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
import { GENERIC_REVIEW_SYSTEM_PROMPT, buildReviewPrompt, parseReviewResponse } from "./domain/generic.js";
import type { BudgetCoordinator, BudgetDecision, ResolveVectorConfig, ReviewerConfig } from "./policy.js";
import { checkExternalBudget } from "./policy.js";
import type { ResolveResult, ResolvedReviewer, ReviewerOutput } from "./providers.js";
import type { CouncilVerdict, EvidenceItem, ReviewerReceipt, VerdictStatus } from "./receipts.js";
import { newReceiptId, redactSecrets } from "./receipts.js";

export interface CouncilDeps {
  resolveReviewer: (config: ReviewerConfig) => Promise<ResolveResult>;
  complete: (
    resolved: ResolvedReviewer,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ) => Promise<ReviewerOutput>;
  now?: () => number;
  /** Parent cancellation signal, wired to every reviewer call. */
  signal?: AbortSignal;
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
  // Secrets never cross the external transport boundary, even inside prompts.
  const transportPrompt = resolved.config.local ? buildReviewPrompt(input) : redactSecrets(buildReviewPrompt(input));
  let calls = 0;
  try {
    calls += 1;
    const output = await deps.complete(resolved, GENERIC_REVIEW_SYSTEM_PROMPT, transportPrompt, deps.signal);
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
        usage: output.usage,
      };
    } catch (parseError) {
      // One repair retry (proven in the legacy panel-review experiment): resend
      // the ORIGINAL request plus the bad output, demand bare JSON. Fail closed
      // if it still does not comply — never treat prose as a pass.
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
        deps.signal,
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
    const message = (error as Error).message;
    const isTimeout = /timed?\s*out|timeout|aborted/i.test(message) || (error as Error).name === "TimeoutError";
    return {
      ...base,
      status: isTimeout ? "timeout" : "error",
      calls,
      findings: [],
      latencyMs,
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

export async function runCouncil(input: RunCouncilInput): Promise<CouncilVerdict> {
  const { config, deps } = input;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const receipts: ReviewerReceipt[] = [];

  const eligible: ReviewerConfig[] = [];
  for (const reviewer of config.reviewers) {
    if (!reviewer.enabled) continue;
    if (reviewer.trigger === "escalation") continue; // M1: escalation seats stay cold
    eligible.push(reviewer);
  }

  const resolved = await mapLimited(eligible, config.maxConcurrentReviewers, (reviewer) => deps.resolveReviewer(reviewer));

  const runnable: ResolvedReviewer[] = [];
  const reservations = new Map<string, () => BudgetDecision | Promise<BudgetDecision>>();
  for (let i = 0; i < eligible.length; i++) {
    const result: ResolveResult = resolved[i];
    const reviewerConfig = eligible[i];
    if (!result.ok) {
      receipts.push(skippedReceipt(reviewerConfig, "error", result.detail));
      continue;
    }
    if (input.primaryFamily && result.reviewer.family === input.primaryFamily) {
      receipts.push(
        skippedReceipt(
          reviewerConfig,
          "skipped_same_family",
          `same model family as the primary (${result.reviewer.family}); cross-family review required`,
        ),
      );
      continue;
    }
    if (!reviewerConfig.local) {
      // Reserve BEFORE dispatch; the attempt counts whether or not it succeeds.
      const reserve = (): BudgetDecision | Promise<BudgetDecision> =>
        deps.budget
          ? deps.budget.tryReserve(now())
          : checkExternalBudget(config, deps.externalTimestamps ?? [], now());
      const decision = await reserve();
      if (!decision.allowed) {
        receipts.push(skippedReceipt(reviewerConfig, "skipped_budget", decision.reason ?? "budget reached"));
        continue;
      }
      reservations.set(reviewerConfig.id, reserve);
    }
    runnable.push(result.reviewer);
  }

  const runReceipts = await mapLimited(runnable, config.maxConcurrentReviewers, (reviewer) =>
    reviewWith(reviewer, input, deps, reservations.get(reviewer.config.id) ?? (() => ({ allowed: true }))),
  );
  receipts.push(...runReceipts);

  const okReceipts = receipts.filter((r) => r.status === "ok" && r.verdict);
  const status = mergeStatuses(okReceipts.map((r) => r.verdict as VerdictStatus));
  const findings = okReceipts.flatMap((r) => r.findings);
  const summary =
    okReceipts.length === 0
      ? "No reviewer completed; review unavailable."
      : okReceipts.map((r) => `${r.reviewerId}: ${r.summary ?? r.verdict}`).join(" | ");

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
    createdAt: new Date(startedAt).toISOString(),
  };
}
