import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  ActivationController,
  analyzeTurn,
  buildExecutionMessage,
  buildPlanMessage,
  buildSteeringContext,
  RV_CORRECTION_TYPE,
  RV_PLAN_TYPE,
  RV_STEERING_TYPE,
  shouldActivate,
  type ActivationDeps,
} from "../src/activation.js";
import { DEFAULT_CONFIG, type ResolveVectorConfig } from "../src/policy.js";
import type { CouncilVerdict, VerdictStatus } from "../src/receipts.js";
import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";
import type { RVEngine, RunReviewRequest } from "../src/runtime.js";

// Fake ctx: the controller only forwards it to the (faked) runtime and deps.
const ctx = { isTestDouble: true } as unknown as ExtensionContext;

function verdict(status: VerdictStatus, summary = "s"): CouncilVerdict {
  return {
    id: `rv-${status}`,
    mode: "review",
    status,
    summary,
    findings:
      status === "concern" || status === "fail"
        ? [
            {
              severity: "high",
              category: "correctness",
              claim: "2+2=5",
              concern: "contradicts arithmetic",
              evidence: [],
              suggestedCorrection: "state 4",
            },
          ]
        : [],
    reviewers: [],
    deterministicChecks: [],
    usage: { input: 0, output: 0, totalLatencyMs: 1 },
    createdAt: new Date(0).toISOString(),
  };
}

function assistantTurn(text: string): unknown[] {
  return [{ role: "assistant", content: [{ type: "text", text }] }];
}

function correctionTurn(correctionId: string, revisedText = "the revised answer, long enough to matter"): unknown[] {
  return [
    { role: "custom", customType: RV_CORRECTION_TYPE, content: [], details: { correctionId } },
    ...assistantTurn(revisedText),
  ];
}

function planTurn(planId: string, planText = "1. fix the arithmetic\n2. restate the result"): unknown[] {
  return [
    { role: "custom", customType: RV_PLAN_TYPE, content: [], details: { planId } },
    ...assistantTurn(planText),
  ];
}

function steeringTurn(correctionId: string, userText: string, revisedText = "the steered answer, long enough to matter"): unknown[] {
  return [
    { role: "custom", customType: RV_STEERING_TYPE, content: [], details: { correctionId } },
    { role: "user", content: [{ type: "text", text: userText }] },
    ...assistantTurn(revisedText),
  ];
}

interface VerdictGate {
  promise: Promise<CouncilVerdict>;
  resolve: (value: CouncilVerdict) => void;
  reject: (reason: unknown) => void;
}

interface Harness {
  controller: ActivationController;
  config: ResolveVectorConfig;
  reviews: RunReviewRequest[];
  signals: (AbortSignal | undefined)[];
  notifications: string[];
  corrections: { text: string; id: string }[];
  plans: { text: string; planId: string; correctionId: string }[];
  setVerdicts: (verdicts: CouncilVerdict[]) => void;
  setProposal: (proposal: string) => void;
  setLeaf: (leaf: string) => void;
  gateNextReview: () => VerdictGate;
}

function makeHarness(mode: ResolveVectorConfig["mode"], overrides: Partial<ResolveVectorConfig> = {}): Harness {
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, mode, reviewers: [], ...overrides };
  const reviews: RunReviewRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const notifications: string[] = [];
  const corrections: { text: string; id: string }[] = [];
  const plans: { text: string; planId: string; correctionId: string }[] = [];
  const queue: (CouncilVerdict | Promise<CouncilVerdict>)[] = [];
  let proposal = "the completed answer under review, long enough to matter";
  let leaf = "leaf-1";
  const engine: RVEngine = {
    paths: { configPath: "/tmp/c", receiptsPath: "/tmp/r", ledgerPath: "/tmp/l" },
    config,
    configErrors: [],
    configCreated: false,
    circuits: new CircuitBreakerRegistry({ cooldownMs: 300_000 }),
    complete: () => Promise.reject(new Error("not under test")),
    setMode: () => {},
    runReview: (_ctx, request, signal) => {
      reviews.push(request);
      signals.push(signal);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error("no verdict queued"));
      return Promise.resolve(next);
    },
    runEnsemble: () => Promise.reject(new Error("not under test")),
    recentReceipts: () => Promise.resolve([]),
    reload: () => Promise.resolve(),
  };
  const deps: ActivationDeps = {
    notify: (_ctx, message) => notifications.push(message),
    sendCorrection: (text, id) => corrections.push({ text, id }),
    sendPlan: (text, planId, correctionId) => plans.push({ text, planId, correctionId }),
    leafEntryId: () => leaf,
    lastExchange: () => ({ goal: "the goal", proposal }),
    primaryFamily: () => "glm",
    rng: () => 0.5,
  };
  return {
    controller: new ActivationController(engine, deps),
    config,
    reviews,
    signals,
    notifications,
    corrections,
    plans,
    setVerdicts: (verdicts) => queue.push(...verdicts),
    setProposal: (next) => {
      proposal = next;
    },
    setLeaf: (next) => {
      leaf = next;
    },
    gateNextReview: () => {
      const gate = Promise.withResolvers<CouncilVerdict>();
      queue.push(gate.promise);
      return gate;
    },
  };
}

test("analyzeTurn: substantive text, tool mutations, correction markers and ids", () => {
  const short = analyzeTurn([{ role: "assistant", content: [{ type: "text", text: "Done." }] }]);
  assert.equal(short.substantive, false);

  const long = analyzeTurn(assistantTurn("x".repeat(50)));
  assert.equal(long.substantive, true);
  assert.equal(long.filesChanged, false);

  // vllm-mlx quirk: the whole reply arrives as thinking with empty text.
  const thinkingOnly = analyzeTurn([
    { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(60) }] },
  ]);
  assert.equal(thinkingOnly.substantive, true);
  assert.equal(thinkingOnly.proposal, "x".repeat(60));

  const edited = analyzeTurn([
    { role: "toolResult", toolName: "edit", content: [] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  assert.equal(edited.substantive, true);
  assert.equal(edited.filesChanged, true);

  const rvTurn = analyzeTurn(correctionTurn("rv-cor-0-1"));
  assert.equal(rvTurn.isReviewTurn, true);
  assert.equal(rvTurn.correctionId, "rv-cor-0-1");

  const unmarked = analyzeTurn([{ role: "custom", customType: RV_CORRECTION_TYPE, content: [] }]);
  assert.equal(unmarked.isReviewTurn, true);
  assert.equal(unmarked.correctionId, undefined);
});

test("shouldActivate honors every mode", () => {
  const turn: Parameters<typeof shouldActivate>[1] = {
    substantive: true,
    proposal: "Implemented the full migration and fixed the callers.",
    filesChanged: false,
    researchToolsUsed: false,
    ensembleOutput: false,
    isReviewTurn: false,
  };
  const base = { ...DEFAULT_CONFIG, reviewers: [] };
  assert.equal(shouldActivate({ ...base, mode: "off" }, turn, () => 0).activate, false);
  assert.equal(shouldActivate({ ...base, mode: "manual" }, turn, () => 0).activate, false);
  assert.equal(shouldActivate({ ...base, mode: "always" }, turn, () => 0.9).activate, true);
  assert.equal(shouldActivate({ ...base, mode: "always" }, turn, () => 0.9).reason, "always");
  assert.equal(shouldActivate({ ...base, mode: "sample", sampleRate: 0.1 }, turn, () => 0.05).activate, true);
  assert.equal(shouldActivate({ ...base, mode: "sample", sampleRate: 0.1 }, turn, () => 0.5).activate, false);
  assert.equal(shouldActivate({ ...base, mode: "always" }, { ...turn, isReviewTurn: true }, () => 0).activate, false);
});

test("auto mode fires on deterministic consequence signals, not length", () => {
  const base = { ...DEFAULT_CONFIG, mode: "auto" as const, reviewers: [] };
  const dry = { substantive: true, filesChanged: false, researchToolsUsed: false, ensembleOutput: false, isReviewTurn: false };
  const activate = (turn: Partial<Parameters<typeof shouldActivate>[1]>) =>
    shouldActivate(base, { ...dry, ...turn } as Parameters<typeof shouldActivate>[1], () => 0);

  // Each consequence signal fires with its reason tag.
  assert.deepEqual(activate({ filesChanged: true }), { activate: true, reason: "files_changed" });
  assert.deepEqual(activate({ ensembleOutput: true }), { activate: true, reason: "ensemble_verification" });
  assert.deepEqual(activate({ userText: "please verify this migration" }), { activate: true, reason: "user_requested" });
  assert.deepEqual(activate({ proposal: "Implemented the retry logic and fixed the tests." }), {
    activate: true,
    reason: "completion_claim",
  });
  assert.deepEqual(activate({ proposal: "The root cause is a stale cache; the fix is to invalidate on write." }), {
    activate: true,
    reason: "diagnosis",
  });
  assert.deepEqual(activate({ proposal: "I recommend postgres over sqlite for this workload." }), {
    activate: true,
    reason: "recommendation",
  });
  assert.deepEqual(activate({ researchToolsUsed: true, proposal: "The config loader reads yaml then env overrides." }), {
    activate: true,
    reason: "source_report",
  });

  // Length alone is NOT a signal anymore.
  assert.equal(activate({ proposal: "x".repeat(600) }).activate, false);
  // Neutral short statement: no consequence signal.
  assert.equal(activate({ proposal: "The file lives under src/tools today." }).activate, false);
});

test("auto mode avoids trivial turns", () => {
  const base = { ...DEFAULT_CONFIG, mode: "auto" as const, reviewers: [] };
  const dry = { substantive: true, filesChanged: false, researchToolsUsed: false, ensembleOutput: false, isReviewTurn: false };
  const activate = (turn: Partial<Parameters<typeof shouldActivate>[1]>) =>
    shouldActivate(base, { ...dry, ...turn } as Parameters<typeof shouldActivate>[1], () => 0).activate;

  assert.equal(activate({ proposal: "Thanks!" }), false); // acknowledgment
  assert.equal(activate({ proposal: "Which database should I use for the migration?" }), false); // clarification question
  assert.equal(activate({ isReviewTurn: true, proposal: "x".repeat(100) }), false); // RV's own turn
  assert.equal(activate({ substantive: false, proposal: "Done." }), false); // not substantive
});

test("always mode reviews a substantive turn; pass renders verified, no plan, no correction", async () => {
  const h = makeHarness("always");
  h.setVerdicts([verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0].activationReason, "agent_end");
  assert.equal(h.corrections.length, 0);
  assert.equal(h.plans.length, 0);
  assert.ok(h.notifications.some((n) => n.includes("verified")));
  assert.ok(h.notifications.some((n) => n.includes("review started")));
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
});

test("off and manual modes never activate", async () => {
  for (const mode of ["off", "manual"] as const) {
    const h = makeHarness(mode);
    await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
    assert.equal(h.reviews.length, 0, mode);
  }
});

test("concern: verdict visible, ONE plan-only request, NO execution turn until the user acts", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  // No correction ever fires autonomously.
  assert.equal(h.corrections.length, 0);
  // Exactly one plan request, carrying plan + correction ids.
  assert.equal(h.plans.length, 1);
  assert.match(h.plans[0].text, /CONCERN/);
  assert.match(h.plans[0].text, /2\+2=5/);
  assert.match(h.plans[0].text, /PLAN ONLY/);
  assert.match(h.plans[0].text, /forbidden this turn/);
  // Verdict rendered visibly (findings block) before the plan.
  assert.ok(h.notifications.some((n) => n.includes("remediation plan requested (round 1/2)")));
  assert.ok(h.notifications.some((n) => n.includes("Resolve Vector review verdict: CONCERN")));
  assert.equal(h.controller.reviewState.revisionRound, 1);
  assert.equal(h.controller.reviewState.pendingPlan?.planId, h.plans[0].planId);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
});

test("plan turn completion opens the user gate and captures the plan", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  const planId = h.plans[0].planId;
  await h.controller.onAgentEnd(planTurn(planId), ctx);
  const gate = h.controller.reviewState.awaitingUser;
  assert.ok(gate, "gate must open when the plan turn ends");
  assert.equal(gate.plan, "1. fix the arithmetic\n2. restate the result");
  assert.equal(gate.correctionId, h.plans[0].correctionId);
  assert.equal(h.controller.reviewState.pendingPlan, undefined);
  // No review of the plan turn, no execution turn.
  assert.equal(h.reviews.length, 1);
  assert.equal(h.corrections.length, 0);
  assert.ok(h.notifications.some((n) => n.includes("awaiting your decision")));
});

test("proceed: user-authorized execution carries findings + plan, reviewed once as revision", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  const planId = h.plans[0].planId;
  await h.controller.onAgentEnd(planTurn(planId), ctx);
  h.controller.proceedWithPlan(ctx);
  assert.equal(h.corrections.length, 1);
  assert.match(h.corrections[0].text, /authorized execution/);
  assert.match(h.corrections[0].text, /1\. fix the arithmetic/);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].activationReason, "revision");
  assert.equal(h.reviews[1].revisionRound, 1);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  // The same marker turn again: consumed, never re-reviewed.
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
  assert.equal(h.reviews.length, 2);
});

test("revise attaches user instructions to the execution turn", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("fail")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  h.controller.proceedWithPlan(ctx, "keep the public API unchanged");
  assert.equal(h.corrections.length, 1);
  assert.match(h.corrections[0].text, /User steering instructions: keep the public API unchanged/);
});

test("dismiss closes the gate without any turn", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  h.controller.dismissGate(ctx);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.equal(h.corrections.length, 0);
  assert.ok(h.notifications.some((n) => n.includes("review dismissed")));
});

test("details reprints verdict and pending plan; gate commands are inert without a gate", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.controller.proceedWithPlan(ctx);
  h.controller.dismissGate(ctx);
  h.controller.gateDetails(ctx);
  assert.ok(h.notifications.some((n) => n.includes("no pending review decision")));
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  const before = h.notifications.length;
  h.controller.gateDetails(ctx);
  assert.ok(h.notifications.slice(before).some((n) => n.includes("Resolve Vector review verdict: CONCERN")));
  assert.ok(h.notifications.slice(before).some((n) => n.includes("1. fix the arithmetic")));
});

test("ordinary user text at the gate: steering attached, consumed, reviewed once as revision", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("fail"), verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  const gate = h.controller.reviewState.awaitingUser;
  assert.ok(gate);
  // before_agent_start attaches findings + plan to the user's turn.
  const result = h.controller.onBeforeAgentStart();
  assert.ok(result && "message" in result && result.message);
  const message = result.message as { customType: string; details: { correctionId: string }; content: { text: string }[] };
  assert.equal(message.customType, RV_STEERING_TYPE);
  assert.equal(message.details.correctionId, gate.correctionId);
  assert.match(message.content[0].text, /2\+2=5/);
  assert.match(message.content[0].text, /Pending remediation plan/);
  // The steered turn completes: consumed, reviewed once as a revision.
  await h.controller.onAgentEnd(steeringTurn(gate.correctionId, "go ahead and fix it"), ctx);
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].activationReason, "revision");
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
});

test("steering that produces nothing substantive closes the gate without a review", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  const gate = h.controller.reviewState.awaitingUser;
  await h.controller.onAgentEnd(steeringTurn(gate!.correctionId, "ok", "ok"), ctx);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
  assert.ok(h.notifications.some((n) => n.includes("gate closed")));
});

test("unrelated agent_end while the gate is open is ignored; gate survives", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  await h.controller.onAgentEnd(assistantTurn("some background completion, long enough to matter"), ctx);
  assert.equal(h.reviews.length, 1);
  assert.ok(h.controller.reviewState.awaitingUser);
});

test("onBeforeAgentStart is void when no gate is open", () => {
  const h = makeHarness("always");
  assert.equal(h.controller.onBeforeAgentStart(), undefined);
});

test("revision still fails: fresh plan and pause again — never chained autonomous corrections", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("fail")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  h.controller.proceedWithPlan(ctx);
  assert.equal(h.corrections.length, 1);
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
  // Round 2: exactly one NEW plan request, zero new corrections, gate re-opens.
  assert.equal(h.corrections.length, 1);
  assert.equal(h.plans.length, 2);
  assert.equal(h.controller.reviewState.revisionRound, 2);
  assert.ok(h.notifications.some((n) => n.includes("remediation plan requested (round 2/2)")));
  await h.controller.onAgentEnd(planTurn(h.plans[1].planId), ctx);
  assert.ok(h.controller.reviewState.awaitingUser);
});

test("unresolved after maxRevisionRounds: loop stops and asks the user", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 1 });
  h.setVerdicts([verdict("concern"), verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  h.controller.proceedWithPlan(ctx);
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
  assert.equal(h.plans.length, 1); // round 1 only; no second plan
  assert.equal(h.corrections.length, 1);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.ok(h.notifications.some((n) => /unresolved after 1 revision round/.test(n)));
});

test("a stale/uncorrelated rv-correction marker does not activate anything", async () => {
  const h = makeHarness("always");
  await h.controller.onAgentEnd(correctionTurn("rv-cor-9-9"), ctx);
  assert.equal(h.reviews.length, 0);
});

test("the same leaf entry is never reviewed twice", async () => {
  const h = makeHarness("always");
  h.setVerdicts([verdict("pass")]);
  const turn = assistantTurn("a substantive answer long enough to matter");
  await h.controller.onAgentEnd(turn, ctx);
  await h.controller.onAgentEnd(turn, ctx); // same leaf
  assert.equal(h.reviews.length, 1);
});

test("two completions during one review: newest pending is reviewed once", async () => {
  const h = makeHarness("always");
  const gate = h.gateNextReview();
  h.setVerdicts([]);
  const first = h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  // Two substantive completions land while the first review is in flight.
  h.setLeaf("leaf-2");
  h.setProposal("middle answer that will be superseded by the newest one");
  await h.controller.onAgentEnd(assistantTurn("middle answer that will be superseded by the newest one"), ctx);
  h.setLeaf("leaf-3");
  h.setProposal("newest answer that must be reviewed after the in-flight one");
  await h.controller.onAgentEnd(assistantTurn("newest answer that must be reviewed after the in-flight one"), ctx);
  h.setVerdicts([verdict("pass")]);
  gate.resolve(verdict("pass"));
  await first;
  // Exactly one follow-up review, and it covered the NEWEST proposal.
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].proposal, "newest answer that must be reviewed after the in-flight one");
  assert.equal(h.reviews[1].activationReason, "agent_end");
});

test("session switch during a slow review: no side effects reach the new session", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  const gate = h.gateNextReview();
  const first = h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  // Session B starts: reset invalidates generation and aborts the review.
  h.controller.reset();
  const notesAtReset = h.notifications.length;
  gate.resolve(verdict("fail")); // A's review finishes AFTER the switch
  await first;
  // No notification, correction, or state mutation from the dead session.
  assert.equal(h.notifications.length, notesAtReset);
  assert.equal(h.corrections.length, 0);
  assert.equal(h.controller.reviewState.reviewing, false);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  assert.equal(h.controller.reviewState.lastReviewedEntryId, undefined);
  // Cancellation actually reached the reviewer transport.
  assert.equal(h.signals[0]?.aborted, true);
});

test("reset during an in-flight pass: stale completion cannot overwrite fresh state", async () => {
  const h = makeHarness("always");
  const gate = h.gateNextReview();
  const first = h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  h.controller.reset();
  const notesAtReset = h.notifications.length;
  gate.resolve(verdict("pass"));
  await first;
  assert.equal(h.notifications.length, notesAtReset); // no "verified" from the stale review
  assert.equal(h.controller.reviewState.lastReviewedEntryId, undefined);
  assert.equal(h.controller.reviewState.reviewing, false);
});

test("split: terminal escalation — no correction, no round, clean state", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("split", "qwen says pass, kimi says fail")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.corrections.length, 0, "split must never send a hidden correction");
  assert.equal(h.controller.reviewState.revisionRound, 0, "split must not increment revisionRound");
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  assert.ok(h.notifications.some((n) => n.includes("split verdict — user decision needed")));
});

test("split mid-loop clears gate state; a later normal turn starts cleanly", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("split"), verdict("pass")]);
  // Round 1: concern → plan gate (no correction yet).
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.plans.length, 1);
  assert.equal(h.controller.reviewState.revisionRound, 1);
  await h.controller.onAgentEnd(planTurn(h.plans[0].planId), ctx);
  h.controller.proceedWithPlan(ctx);
  assert.equal(h.corrections.length, 1);
  // The revision turn comes back SPLIT: loop must stop without correcting.
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
  assert.equal(h.plans.length, 1, "split must not trigger another plan");
  assert.equal(h.corrections.length, 1, "split must not send another correction");
  assert.equal(h.controller.reviewState.revisionRound, 0, "split resets the loop");
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
  assert.ok(h.notifications.some((n) => n.includes("user decision needed")));
  // A later normal user turn starts cleanly — no stale loop state.
  h.setLeaf("leaf-9");
  h.setProposal("a fresh unrelated answer, definitely long enough to review");
  await h.controller.onAgentEnd(assistantTurn("a fresh unrelated answer, definitely long enough to review"), ctx);
  assert.equal(h.reviews.length, 3);
  assert.equal(h.reviews[2].activationReason, "agent_end");
  assert.equal(h.reviews[2].revisionRound, 0);
  assert.equal(h.corrections.length, 1);
});

test("review_unavailable: actionable message, never verified, no plan, no correction", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  const unavailable = verdict("review_unavailable", "No reviewer completed");
  unavailable.reviewers = [
    {
      reviewerId: "fake-local",
      provider: "fake-local",
      model: "fake-qwen",
      family: "qwen",
      local: true,
      status: "timeout",
      calls: 1,
      findings: [],
      latencyMs: 3000,
      failureCategory: "timeout_first_token",
      error: "no meaningful token within 3s",
      circuitState: "open",
    },
  ];
  h.setVerdicts([unavailable]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.plans.length, 0);
  assert.equal(h.corrections.length, 0);
  assert.equal(h.controller.reviewState.awaitingUser, undefined);
  assert.ok(!h.notifications.some((n) => n.startsWith("RV · verified")));
  assert.ok(h.notifications.some((n) => n.includes("review unavailable")));
  assert.ok(h.notifications.some((n) => n.includes("NOT verified")));
  assert.ok(h.notifications.some((n) => n.includes("/rv doctor probe")));
  assert.ok(h.notifications.some((n) => n.includes("No automatic correction will run")));
});

test("buildPlanMessage prohibits edits and mutating tools", () => {
  const text = buildPlanMessage(verdict("fail"));
  assert.match(text, /FAIL/);
  assert.match(text, /\[high\/correctness\] 2\+2=5 — contradicts arithmetic/);
  assert.match(text, /PLAN ONLY/);
  assert.match(text, /edit\/write\/bash are forbidden this turn/);
  assert.match(text, /Do NOT implement/);
});

test("buildExecutionMessage carries findings, plan, and authorization", () => {
  const gate = { verdict: verdict("concern"), plan: "1. fix it" };
  const text = buildExecutionMessage(gate, "be careful");
  assert.match(text, /CONCERN/);
  assert.match(text, /1\. fix it/);
  assert.match(text, /User steering instructions: be careful/);
  assert.match(text, /authorized execution/);
});

test("buildSteeringContext attaches findings and the pending plan", () => {
  const gate = { verdict: verdict("fail"), plan: "1. fix it" };
  const text = buildSteeringContext(gate);
  assert.match(text, /FAIL/);
  assert.match(text, /Pending remediation plan/);
  assert.match(text, /steering/);
});
