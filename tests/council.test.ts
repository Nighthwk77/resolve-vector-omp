import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeStatuses, runCouncil, type CouncilDeps } from "../src/council.js";
import { DEFAULT_CONFIG, ExternalBudgetTracker, type ResolveVectorConfig, type ReviewerConfig } from "../src/policy.js";
import type { ResolveResult, ResolvedReviewer } from "../src/providers.js";

const reviewerA: ReviewerConfig = {
  id: "local-qwen",
  provider: "vllm-mlx",
  model: "qwen3-coder",
  family: "qwen",
  role: "critic",
  local: true,
  enabled: true,
  order: 1,
};

const reviewerB: ReviewerConfig = {
  id: "remote-deepseek",
  provider: "deepseek",
  model: "deepseek-chat",
  family: "deepseek",
  role: "verifier",
  local: false,
  enabled: true,
  order: 2,
};

function configWith(reviewers: ReviewerConfig[], overrides: Partial<ResolveVectorConfig> = {}): ResolveVectorConfig {
  return { ...DEFAULT_CONFIG, reviewers, ...overrides };
}

function okResolution(config: ReviewerConfig): ResolveResult {
  const reviewer = {
    config,
    model: { provider: config.provider, id: config.model },
    family: config.family,
    apiKey: config.local ? undefined : "fake-key",
  } as unknown as ResolvedReviewer;
  return { ok: true, reviewer };
}

function passJson(summary = "looks sound") {
  return JSON.stringify({ status: "pass", summary, findings: [] });
}

function makeDeps(answers: Record<string, string | Error>, overrides: Partial<CouncilDeps> = {}): CouncilDeps {
  return {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved) => {
      const answer = answers[resolved.config.id] ?? passJson();
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { input: 100, output: 50 } };
    },
    ...overrides,
  };
}

const baseInput = { goal: "port function X", proposal: "here is the port…" };

test("mergeStatuses precedence: fail beats concern beats pass", () => {
  assert.equal(mergeStatuses(["pass", "concern"]), "concern");
  assert.equal(mergeStatuses(["concern", "fail"]), "fail");
  assert.equal(mergeStatuses(["pass", "pass"]), "pass");
  assert.equal(mergeStatuses([]), "review_unavailable");
});

test("mergeStatuses: pass-vs-fail disagreement is a split", () => {
  assert.equal(mergeStatuses(["pass", "fail"]), "split");
});

test("runCouncil merges two cross-family reviewers and preserves findings", async () => {
  const concernJson = JSON.stringify({
    status: "concern",
    summary: "method is off",
    findings: [
      {
        severity: "high",
        category: "method",
        claim: "coefficient copied from wrong branch",
        concern: "breaks under PvP scaling",
        evidence: [{ kind: "file", ref: "engine.cpp:412" }],
        suggestedCorrection: "re-read the cited lines",
      },
    ],
  });
  const verdict = await runCouncil({
    ...baseInput,
    primaryFamily: "glm",
    config: configWith([reviewerA, reviewerB]),
    deps: makeDeps({ "local-qwen": passJson(), "remote-deepseek": concernJson }),
  });
  assert.equal(verdict.status, "concern");
  assert.equal(verdict.findings.length, 1);
  assert.equal(verdict.findings[0].claim, "coefficient copied from wrong branch");
  assert.equal(verdict.reviewers.length, 2);
  assert.ok(verdict.reviewers.every((r) => r.status === "ok"));
  assert.equal(verdict.usage.input, 200);
  assert.equal(verdict.usage.output, 100);
});

test("runCouncil skips same-family reviewers — never GLM-audits-GLM", async () => {
  const verdict = await runCouncil({
    ...baseInput,
    primaryFamily: "qwen",
    config: configWith([reviewerA, reviewerB]),
    deps: makeDeps({ "remote-deepseek": passJson() }),
  });
  const skipped = verdict.reviewers.find((r) => r.reviewerId === "local-qwen");
  assert.equal(skipped?.status, "skipped_same_family");
  assert.match(skipped?.error ?? "", /cross-family/);
  assert.equal(verdict.status, "pass"); // deepseek still ran
});

test("runCouncil blocks external reviewers when the budget is spent", async () => {
  const now = 10_000_000_000;
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerB], { maxExternalAuditsPerHour: 1 }),
    deps: makeDeps(
      { "local-qwen": passJson() },
      { now: () => now, externalTimestamps: [now - 1000] },
    ),
  });
  const blocked = verdict.reviewers.find((r) => r.reviewerId === "remote-deepseek");
  assert.equal(blocked?.status, "skipped_budget");
  assert.match(blocked?.error ?? "", /budget/);
  // The local reviewer still ran — budget never blocks local seats.
  assert.equal(verdict.reviewers.find((r) => r.reviewerId === "local-qwen")?.status, "ok");
});

test("runCouncil degrades to review_unavailable when every reviewer fails", async () => {
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA]),
    deps: makeDeps({ "local-qwen": new Error("connection refused") }),
  });
  assert.equal(verdict.status, "review_unavailable");
  assert.equal(verdict.reviewers[0].status, "error");
  assert.match(verdict.summary, /unavailable/);
});

test("runCouncil repairs one unparseable response and accepts the retry", async () => {
  let calls = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async () => {
      calls += 1;
      return { text: calls === 1 ? "I think it looks fine tbh" : passJson("sound after repair") };
    },
  };
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA]),
    deps,
  });
  assert.equal(calls, 2);
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.reviewers[0].status, "ok");
});

test("runCouncil marks reviewer output as error only after the repair also fails", async () => {
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA]),
    deps: makeDeps({ "local-qwen": "I think it is probably fine honestly" }),
  });
  assert.equal(verdict.reviewers[0].status, "error");
  assert.match(verdict.reviewers[0].error ?? "", /unparseable verdict after repair/);
  assert.match(verdict.reviewers[0].error ?? "", /raw output began/);
  assert.equal(verdict.reviewers[0].calls, 2);
  assert.equal(verdict.status, "review_unavailable");
});

test("runCouncil classifies timeouts separately from errors", async () => {
  const timeout = new Error("The operation timed out");
  timeout.name = "TimeoutError";
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerB]),
    deps: makeDeps({ "local-qwen": timeout, "remote-deepseek": passJson() }),
  });
  assert.equal(verdict.reviewers.find((r) => r.reviewerId === "local-qwen")?.status, "timeout");
  assert.equal(verdict.status, "pass");
});

test("runCouncil never calls disabled or escalation-trigger seats", async () => {
  const called: string[] = [];
  const deps = makeDeps({});
  const complete: CouncilDeps["complete"] = async (resolved, s, p) => {
    called.push(resolved.config.id);
    return { text: passJson() };
  };
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([
      reviewerA,
      { ...reviewerB, enabled: false },
      { ...reviewerB, id: "claude-escalation", trigger: "escalation" },
    ]),
    deps: { ...deps, complete },
  });
  assert.deepEqual(called, ["local-qwen"]);
  assert.equal(verdict.reviewers.length, 1);
});

test("policy: an external seat with local-only scope is skipped and fails closed", async () => {
  const blocked = { ...reviewerB, scope: "local-only" as const };
  const prompts: string[] = [];
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _s, prompt) => {
      prompts.push(prompt);
      return { text: passJson() };
    },
  };
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([blocked]),
    deps,
  });
  assert.equal(prompts.length, 0, "local-only external seat must never receive content");
  assert.equal(verdict.reviewers[0].status, "skipped_policy");
  assert.match(verdict.reviewers[0].error ?? "", /local-only/);
  assert.equal(verdict.status, "review_unavailable"); // fail closed, not silently pass
});

test("policy: external-redacted redacts, external-allowed sends full content", async () => {
  const prompts = new Map<string, string>();
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved, _s, prompt) => {
      prompts.set(resolved.config.id, prompt);
      return { text: passJson() };
    },
  };
  const redacted = { ...reviewerB, id: "ext-redacted", scope: "external-redacted" as const };
  const allowed = { ...reviewerB, id: "ext-allowed", scope: "external-allowed" as const };
  await runCouncil({
    goal: "deploy",
    proposal: "deploy with key sk-proj-abc123def456ghi789 now",
    config: configWith([redacted, allowed]),
    deps,
  });
  assert.ok(!(prompts.get("ext-redacted") ?? "").includes("sk-proj-abc123def456ghi789"));
  assert.match(prompts.get("ext-redacted") ?? "", /\[REDACTED\]/);
  assert.match(prompts.get("ext-allowed") ?? "", /sk-proj-abc123def456ghi789/); // explicit full trust
});

test("runCouncil wires the parent AbortSignal to every reviewer call, repairs included", async () => {
  const controller = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  let calls = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, _prompt, options) => {
      seen.push(options?.signal);
      calls += 1;
      return { text: calls === 1 ? "not json" : passJson() };
    },
    signal: controller.signal,
  };
  await runCouncil({ ...baseInput, config: configWith([reviewerA]), deps });
  assert.equal(seen.length, 2); // initial + repair
  assert.ok(seen.every((s) => s === controller.signal));
});

test("runCouncil redacts secrets from prompts to external reviewers only", async () => {
  const prompts = new Map<string, string>();
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved, _system, prompt) => {
      prompts.set(resolved.config.id, prompt);
      return { text: passJson() };
    },
  };
  await runCouncil({
    goal: "check the deploy",
    proposal: "deploy with key sk-proj-abc123def456ghi789 now",
    config: configWith([reviewerA, reviewerB]),
    deps,
  });
  // Local reviewer sees the prompt verbatim…
  assert.match(prompts.get("local-qwen") ?? "", /sk-proj-abc123def456ghi789/);
  // …external transport gets the redacted form.
  assert.ok(!(prompts.get("remote-deepseek") ?? "").includes("sk-proj-abc123def456ghi789"));
  assert.match(prompts.get("remote-deepseek") ?? "", /\[REDACTED\]/);
});

test("runCouncil budget reservations are atomic across concurrent councils", async () => {
  const now = 10_000_000_000;
  const tracker = new ExternalBudgetTracker(
    configWith([], { maxExternalAuditsPerHour: 1 }),
    [],
  );
  let externalDispatches = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved) => {
      if (!resolved.config.local) externalDispatches += 1;
      return { text: passJson() };
    },
    now: () => now,
    budget: tracker,
  };
  const input = { ...baseInput, config: configWith([reviewerB]), deps };
  const [first, second] = await Promise.all([runCouncil(input), runCouncil(input)]);
  assert.equal(externalDispatches, 1);
  const statuses = [first, second].map((v) => v.reviewers[0].status).sort();
  assert.deepEqual(statuses, ["ok", "skipped_budget"]);
});

test("runCouncil counts a failed external attempt against the budget", async () => {
  const now = 10_000_000_000;
  const tracker = new ExternalBudgetTracker(configWith([], { maxExternalAuditsPerHour: 1 }), []);
  const failing: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async () => {
      throw new Error("provider 500");
    },
    now: () => now,
    budget: tracker,
  };
  const first = await runCouncil({ ...baseInput, config: configWith([reviewerB]), deps: failing });
  assert.equal(first.reviewers[0].status, "error");
  assert.equal(first.reviewers[0].calls, 1);
  // The failed attempt consumed the single hourly slot.
  const second = await runCouncil({ ...baseInput, config: configWith([reviewerB]), deps: failing });
  assert.equal(second.reviewers[0].status, "skipped_budget");
  assert.equal(second.reviewers[0].calls, 0);
});

test("runCouncil repair retry includes the original review request", async () => {
  const prompts: string[] = [];
  let calls = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, prompt) => {
      prompts.push(prompt);
      calls += 1;
      return { text: calls === 1 ? "garbage prose" : passJson() };
    },
  };
  await runCouncil({
    goal: "UNIQUE-GOAL-MARKER",
    proposal: "UNIQUE-PROPOSAL-MARKER",
    config: configWith([reviewerA]),
    deps,
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Original review request/);
  assert.match(prompts[1], /UNIQUE-GOAL-MARKER/);
  assert.match(prompts[1], /UNIQUE-PROPOSAL-MARKER/);
  assert.match(prompts[1], /garbage prose/); // plus the offending output
});

/* ─────────────── stalled-reviewer handling (Qwen/vllm-mlx regression) ─────────────── */

import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";
import { ReviewerCallError } from "../src/stream-guard.js";
import { renderStatusLine } from "../src/render.js";
import type { CouncilProgressEvent } from "../src/council.js";

const reviewerKimi: ReviewerConfig = {
  id: "kimi",
  provider: "kimi-code",
  model: "kimi-for-coding",
  family: "moonshot",
  role: "verifier",
  local: false,
  enabled: true,
  order: 2,
};

test("first-token timeout: no retry, no repair, typed receipt, immediate continuation", async () => {
  let qwenCalls = 0;
  const events: CouncilProgressEvent[] = [];
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved) => {
      if (resolved.config.id === "local-qwen") {
        qwenCalls += 1;
        throw new ReviewerCallError("timeout_first_token", "no meaningful token within 10s — generation unresponsive", {
          connectLatencyMs: 180,
          totalLatencyMs: 10_000,
        });
      }
      return { text: passJson("kimi says sound") };
    },
    onProgress: (event) => events.push(event),
  };
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerKimi]),
    deps,
  });
  const qwen = verdict.reviewers.find((r) => r.reviewerId === "local-qwen");
  assert.equal(qwen?.status, "timeout_first_token");
  assert.equal(qwen?.failureCategory, "timeout_first_token");
  assert.equal(qwen?.connectLatencyMs, 180, "connection latency recorded in the receipt");
  assert.equal(qwenCalls, 1, "never retried, never repair-attempted after a transport timeout");
  // The healthy seat's verdict still ships.
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.coverageDegraded, true);
  assert.match(verdict.summary, /reduced coverage/);
  // Progress: council start roster + degradation notice naming the survivor.
  assert.deepEqual(events.find((e) => e.type === "council_started"), { type: "council_started", reviewerIds: ["local-qwen", "kimi"] });
  const unavailable = events.find((e) => e.type === "reviewer_unavailable");
  assert.equal(unavailable?.type === "reviewer_unavailable" && unavailable.reviewerId, "local-qwen");
});

test("circuit opens after a generation timeout and skips that reviewer next council", async () => {
  const circuit = new CircuitBreakerRegistry({ cooldownMs: 300_000 });
  let qwenCalls = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved) => {
      if (resolved.config.id === "local-qwen") {
        qwenCalls += 1;
        throw new ReviewerCallError("timeout_first_token", "no meaningful token within 10s");
      }
      return { text: passJson() };
    },
    circuit,
  };
  const first = await runCouncil({ ...baseInput, config: configWith([reviewerA, reviewerKimi]), deps });
  assert.equal(first.reviewers.find((r) => r.reviewerId === "local-qwen")?.circuitState, "open");
  assert.equal(qwenCalls, 1);

  const second = await runCouncil({ ...baseInput, config: configWith([reviewerA, reviewerKimi]), deps });
  const qwen = second.reviewers.find((r) => r.reviewerId === "local-qwen");
  assert.equal(qwen?.status, "skipped_circuit_open");
  assert.equal(qwen?.skipped, true);
  assert.equal(qwen?.circuitState, "open");
  assert.match(qwen?.error ?? "", /retry in \d+s/);
  assert.equal(qwenCalls, 1, "open circuit never dispatches the dead seat");
  assert.equal(second.status, "pass", "healthy reviewer's verdict still returned");
  assert.equal(second.coverageDegraded, true);
});

test("half-open trial after cooldown: a successful meaningful completion closes the circuit", async () => {
  let now = 1_000_000;
  const circuit = new CircuitBreakerRegistry({ cooldownMs: 300_000, now: () => now });
  circuit.recordFailure("local-qwen", "timeout_first_token");
  now += 300_001; // cooldown expired
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async () => ({ text: passJson("qwen recovered") }),
    circuit,
    now: () => now,
  };
  const verdict = await runCouncil({ ...baseInput, config: configWith([reviewerA]), deps });
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.reviewers[0].status, "ok");
  assert.deepEqual(circuit.snapshot("local-qwen"), { state: "closed", remainingMs: 0 });
});

test("healthy remote reviewer returns WITHOUT waiting the 120s total deadline", async () => {
  // Simulated clock: Qwen burns its full 10s first-token budget, Kimi answers
  // in 30s. Verdict must land at ~30s of council time — never 120s.
  let now = 1_000_000;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved) => {
      if (resolved.config.id === "local-qwen") {
        now += 10_000;
        throw new ReviewerCallError("timeout_first_token", "no meaningful token within 10s — generation unresponsive");
      }
      now += 30_000;
      return { text: passJson("kimi verdict") };
    },
    now: () => now,
  };
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerKimi]),
    deps,
  });
  assert.equal(verdict.status, "pass");
  assert.ok(verdict.usage.totalLatencyMs < 60_000, `returned after ${verdict.usage.totalLatencyMs}ms — must not wait 120s`);
  assert.equal(verdict.reviewers.find((r) => r.reviewerId === "local-qwen")?.status, "timeout_first_token");
});

test("reduced coverage is never rendered as fully verified", async () => {
  const deps = makeDeps({
    "local-qwen": new ReviewerCallError("transport", "socket hang up"),
    "remote-deepseek": passJson(),
  });
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerB]),
    deps,
  });
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.coverageDegraded, true);
  const line = renderStatusLine(verdict);
  assert.match(line, /reduced coverage/, "status line must disclose degraded coverage");
  assert.ok(!/^RV · verified$/.test(line), "never the bare 'verified' label");
});

test("all reviewers stalled → review_unavailable, never a silent pass", async () => {
  const deps = makeDeps({
    "local-qwen": new ReviewerCallError("timeout_first_token", "no meaningful token within 10s"),
    "remote-deepseek": new ReviewerCallError("timeout_total", "generation exceeded total deadline of 120s"),
  });
  const verdict = await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerB]),
    deps,
  });
  assert.equal(verdict.status, "review_unavailable");
  assert.equal(verdict.coverageDegraded, undefined, "no successful reviewer → unavailable, not degraded");
});

test("oversized review context is bounded with explicit receipt metadata", async () => {
  const prompts: string[] = [];
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, prompt) => {
      prompts.push(prompt);
      return { text: passJson() };
    },
  };
  const hugeProposal = "A".repeat(500_000);
  const verdict = await runCouncil({
    goal: "check the change",
    proposal: hugeProposal,
    evidence: Array.from({ length: 50 }, (_, i) => ({ kind: "file" as const, ref: `src/file-${i}.ts`, detail: "D".repeat(2_000) })),
    config: configWith([reviewerA]),
    deps,
  });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].length < 500_000, "prompt must be bounded");
  assert.ok(prompts[0].length <= 90_000, `prompt ${prompts[0].length} chars exceeds the configured cap + slack`);
  assert.match(prompts[0], /\[RV: truncated/, "truncation is visible to the reviewer");
  assert.match(prompts[0], /evidence items omitted/, "dropped evidence is disclosed");
  assert.equal(verdict.reviewers[0].inputTruncated, true, "receipt carries explicit truncation metadata");
});

test("small review context is not truncated", async () => {
  const prompts: string[] = [];
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, prompt) => {
      prompts.push(prompt);
      return { text: passJson() };
    },
  };
  const verdict = await runCouncil({ ...baseInput, config: configWith([reviewerA]), deps });
  assert.doesNotMatch(prompts[0], /\[RV: truncated/);
  assert.equal(verdict.reviewers[0].inputTruncated, undefined);
});

test("council passes separate generation deadlines per seat locality", async () => {
  const seen = new Map<string, { firstTokenMs?: number; totalMs?: number; connectMs?: number }>();
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved, _system, _prompt, options) => {
      seen.set(resolved.config.id, {
        connectMs: options?.deadlines?.connectMs,
        firstTokenMs: options?.deadlines?.firstTokenMs,
        totalMs: options?.deadlines?.totalMs,
      });
      return { text: passJson() };
    },
  };
  await runCouncil({
    ...baseInput,
    config: configWith([reviewerA, reviewerKimi], { firstTokenTimeoutMs: 10_000, remoteFirstTokenTimeoutMs: 30_000, totalTimeoutMs: 90_000, connectTimeoutMs: 5_000 }),
    deps,
  });
  assert.deepEqual(seen.get("local-qwen"), { connectMs: 5_000, firstTokenMs: 10_000, totalMs: 90_000 });
  assert.deepEqual(seen.get("kimi"), { connectMs: 5_000, firstTokenMs: 30_000, totalMs: 90_000 });
});

test("truncation preserves the review goal and evidence verbatim — only oversized fields are cut", async () => {
  // Finding: bounding must be field-aware, not a blind size chop. A 1KB goal
  // inside a 500KB payload must survive intact; only the oversized proposal
  // and excess evidence are cut, with markers exactly where content was dropped.
  const prompts: string[] = [];
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, prompt) => {
      prompts.push(prompt);
      return { text: passJson() };
    },
  };
  const goal = "REVIEW-GOAL: " + "verify the port keeps the overflow guard. ".repeat(25); // ~1KB
  const proposal = "P".repeat(499_000); // the oversized payload
  const evidence = Array.from({ length: 30 }, (_, i) => ({ kind: "file" as const, ref: `src/evidence-${i}.ts`, detail: "why it matters" }));
  const verdict = await runCouncil({
    goal,
    proposal,
    evidence,
    config: configWith([reviewerA]),
    deps,
  });
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  assert.ok(prompt.length <= 90_000, `prompt ${prompt.length} chars exceeds cap + slack`);
  assert.ok(prompt.includes(goal), "the full review goal survives verbatim");
  assert.ok(prompt.includes("src/evidence-0.ts") && prompt.includes("src/evidence-19.ts"), "kept evidence items are intact");
  assert.ok(!prompt.includes("src/evidence-29.ts"), "excess evidence is dropped, not partially leaked");
  assert.match(prompt, /\[RV: \d+ further evidence items omitted to bound review context\]/);
  assert.match(prompt, /\[RV: truncated — \d+ chars omitted to bound review context\]/);
  // Markers attach to the proposal section, never to the goal section.
  const goalSection = prompt.slice(prompt.indexOf("## Goal under review"), prompt.indexOf("## Completed answer"));
  assert.doesNotMatch(goalSection, /\[RV:/, "no truncation marker may touch the goal");
  assert.equal(verdict.reviewers[0].inputTruncated, true);
});
