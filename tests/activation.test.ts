import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  ActivationController,
  analyzeTurn,
  buildCorrectionMessage,
  RV_CORRECTION_TYPE,
  shouldActivate,
  type ActivationDeps,
} from "../src/activation.js";
import { DEFAULT_CONFIG, type ResolveVectorConfig } from "../src/policy.js";
import type { CouncilVerdict, VerdictStatus } from "../src/receipts.js";
import type { RVEngine, RunReviewRequest } from "../src/runtime.js";

// Fake ctx: the controller only forwards it to the (faked) runtime.
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

interface Harness {
  controller: ActivationController;
  config: ResolveVectorConfig;
  reviews: RunReviewRequest[];
  notifications: string[];
  corrections: string[];
  setVerdicts: (verdicts: CouncilVerdict[]) => void;
}

function makeHarness(mode: ResolveVectorConfig["mode"], overrides: Partial<ResolveVectorConfig> = {}): Harness {
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, mode, reviewers: [], ...overrides };
  const reviews: RunReviewRequest[] = [];
  const notifications: string[] = [];
  const corrections: string[] = [];
  const queue: CouncilVerdict[] = [];
  const engine: RVEngine = {
    paths: { configPath: "/tmp/c", receiptsPath: "/tmp/r", ledgerPath: "/tmp/l" },
    config,
    configErrors: [],
    configCreated: false,
    setMode: () => {},
    runReview: (_ctx, request) => {
      reviews.push(request);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error("no verdict queued"));
      return Promise.resolve(next);
    },
    recentReceipts: () => Promise.resolve([]),
  };
  const deps: ActivationDeps = {
    notify: (_ctx, message) => notifications.push(message),
    sendCorrection: (text) => corrections.push(text),
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "the goal", proposal: "the completed answer under review, long enough to matter" }),
    primaryFamily: () => "glm",
    rng: () => 0.5,
  };
  return {
    controller: new ActivationController(engine, deps),
    config,
    reviews,
    notifications,
    corrections,
    setVerdicts: (verdicts) => queue.push(...verdicts),
  };
}

test("analyzeTurn: substantive text, tool mutations, and rv-correction markers", () => {
  const short = analyzeTurn([{ role: "assistant", content: [{ type: "text", text: "Done." }] }]);
  assert.equal(short.substantive, false);

  const long = analyzeTurn(assistantTurn("x".repeat(50)));
  assert.equal(long.substantive, true);
  assert.equal(long.filesChanged, false);

  const edited = analyzeTurn([
    { role: "toolResult", toolName: "edit", content: [] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
  assert.equal(edited.substantive, true);
  assert.equal(edited.filesChanged, true);

  const rvTurn = analyzeTurn([{ role: "custom", customType: RV_CORRECTION_TYPE, content: [] }]);
  assert.equal(rvTurn.isReviewTurn, true);
});

test("shouldActivate honors every mode", () => {
  const turn = { substantive: true, proposal: "p".repeat(600), filesChanged: false, isReviewTurn: false };
  const base = { ...DEFAULT_CONFIG, reviewers: [] };
  assert.equal(shouldActivate({ ...base, mode: "off" }, turn, () => 0), false);
  assert.equal(shouldActivate({ ...base, mode: "manual" }, turn, () => 0), false);
  assert.equal(shouldActivate({ ...base, mode: "always" }, turn, () => 0.9), true);
  assert.equal(shouldActivate({ ...base, mode: "sample", sampleRate: 0.1 }, turn, () => 0.05), true);
  assert.equal(shouldActivate({ ...base, mode: "sample", sampleRate: 0.1 }, turn, () => 0.5), false);
  assert.equal(shouldActivate({ ...base, mode: "auto" }, turn, () => 0), true); // long answer
  assert.equal(
    shouldActivate({ ...base, mode: "auto" }, { ...turn, proposal: "short-ish", filesChanged: true }, () => 0),
    true,
  ); // mutation
  assert.equal(
    shouldActivate({ ...base, mode: "auto" }, { ...turn, proposal: "short-ish", filesChanged: false }, () => 0),
    false,
  );
  assert.equal(shouldActivate({ ...base, mode: "always" }, { ...turn, isReviewTurn: true }, () => 0), false);
});

test("always mode reviews a substantive turn; pass renders verified, no correction", async () => {
  const h = makeHarness("always");
  h.setVerdicts([verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.reviews.length, 1);
  assert.equal(h.reviews[0].activationReason, "agent_end");
  assert.equal(h.corrections.length, 0);
  assert.ok(h.notifications.some((n) => n.includes("verified")));
  assert.ok(h.notifications.some((n) => n.includes("provisional")));
});

test("off and manual modes never activate", async () => {
  for (const mode of ["off", "manual"] as const) {
    const h = makeHarness(mode);
    await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
    assert.equal(h.reviews.length, 0, mode);
  }
});

test("concern injects one hidden corrective nextTurn and marks the revision expectation", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.corrections.length, 1);
  assert.match(h.corrections[0], /CONCERN/);
  assert.match(h.corrections[0], /2\+2=5/);
  assert.match(h.corrections[0], /state 4/);
  assert.equal(h.controller.reviewState.revisionRound, 1);
  assert.equal(h.controller.reviewState.expectingRevision, true);
});

test("the revision turn is reviewed once more; pass resets the loop", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  // Revision turn carries the rv-correction marker.
  await h.controller.onAgentEnd([{ role: "custom", customType: RV_CORRECTION_TYPE, content: [] }, ...assistantTurn("revised")], ctx);
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].activationReason, "revision");
  assert.equal(h.reviews[1].revisionRound, 1);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.ok(h.notifications.some((n) => n.includes("verified")));
});

test("recursion guard: an RV-triggered turn never starts a NEW activation", async () => {
  const h = makeHarness("always");
  h.setVerdicts([verdict("pass")]);
  // Marker turn with NO prior correction expectation and no queued expectation:
  // reviewed as a revision turn (not double-activated as a fresh turn).
  await h.controller.onAgentEnd([{ role: "custom", customType: RV_CORRECTION_TYPE, content: [] }], ctx);
  assert.equal(h.reviews.length, 1); // revision review only
  assert.equal(h.reviews[0].activationReason, "revision");
  assert.equal(h.corrections.length, 0); // pass → no further loop
});

test("unresolved after maxRevisionRounds: loop stops and asks the user", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 1 });
  h.setVerdicts([verdict("concern"), verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd([{ role: "custom", customType: RV_CORRECTION_TYPE, content: [] }], ctx);
  assert.equal(h.corrections.length, 1); // round 1 only; no second correction
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.ok(h.notifications.some((n) => /unresolved after 1 revision round/.test(n)));
});

test("the same leaf entry is never reviewed twice", async () => {
  const h = makeHarness("always");
  h.setVerdicts([verdict("pass")]);
  const turn = assistantTurn("a substantive answer long enough to matter");
  await h.controller.onAgentEnd(turn, ctx);
  await h.controller.onAgentEnd(turn, ctx); // same leaf
  assert.equal(h.reviews.length, 1);
});

test("overlap guard: a second agent_end during a review does not double-dispatch", async () => {
  const h = makeHarness("always");
  const gate = Promise.withResolvers<CouncilVerdict>();
  // Rebuild with a gated verdict to hold the review open.
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, mode: "always", reviewers: [] };
  const reviews: RunReviewRequest[] = [];
  const engine: RVEngine = {
    paths: { configPath: "/tmp/c", receiptsPath: "/tmp/r", ledgerPath: "/tmp/l" },
    config,
    configErrors: [],
    configCreated: false,
    setMode: () => {},
    runReview: (_ctx, request) => {
      reviews.push(request);
      return gate.promise;
    },
    recentReceipts: () => Promise.resolve([]),
  };
  const deps: ActivationDeps = {
    notify: () => {},
    sendCorrection: () => {},
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "g", proposal: "a substantive answer long enough to matter" }),
    primaryFamily: () => "glm",
  };
  const controller = new ActivationController(engine, deps);
  const first = controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await controller.onAgentEnd(assistantTurn("another substantive answer long enough"), ctx); // in-flight → skip
  gate.resolve(verdict("pass"));
  await first;
  assert.equal(reviews.length, 1);
});

test("buildCorrectionMessage cites findings and demands resolution", () => {
  const text = buildCorrectionMessage(verdict("fail"));
  assert.match(text, /FAIL/);
  assert.match(text, /\[high\/correctness\] 2\+2=5 — contradicts arithmetic/);
  assert.match(text, /correction: state 4/);
  assert.match(text, /Revise your answer/);
});
