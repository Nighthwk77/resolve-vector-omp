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

test("runCouncil wires the parent AbortSignal to every reviewer call, repairs included", async () => {
  const controller = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  let calls = 0;
  const deps: CouncilDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (_resolved, _system, _prompt, signal) => {
      seen.push(signal);
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
