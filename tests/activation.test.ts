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
  const queue: (CouncilVerdict | Promise<CouncilVerdict>)[] = [];
  let proposal = "the completed answer under review, long enough to matter";
  let leaf = "leaf-1";
  const engine: RVEngine = {
    paths: { configPath: "/tmp/c", receiptsPath: "/tmp/r", ledgerPath: "/tmp/l" },
    config,
    configErrors: [],
    configCreated: false,
    setMode: () => {},
    runReview: (_ctx, request, signal) => {
      reviews.push(request);
      signals.push(signal);
      const next = queue.shift();
      if (!next) return Promise.reject(new Error("no verdict queued"));
      return Promise.resolve(next);
    },
    recentReceipts: () => Promise.resolve([]),
  };
  const deps: ActivationDeps = {
    notify: (_ctx, message) => notifications.push(message),
    sendCorrection: (text, id) => corrections.push({ text, id }),
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

test("concern injects one hidden corrective nextTurn carrying a unique id", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  assert.equal(h.corrections.length, 1);
  assert.match(h.corrections[0].text, /CONCERN/);
  assert.match(h.corrections[0].text, /2\+2=5/);
  assert.match(h.corrections[0].text, /state 4/);
  assert.equal(h.controller.reviewState.revisionRound, 1);
  assert.equal(h.controller.reviewState.pendingCorrectionId, h.corrections[0].id);
});

test("the correlated correction turn is reviewed exactly once as a revision", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  const id = h.corrections[0].id;
  await h.controller.onAgentEnd(correctionTurn(id), ctx);
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].activationReason, "revision");
  assert.equal(h.reviews[1].revisionRound, 1);
  assert.equal(h.controller.reviewState.revisionRound, 0);
  assert.equal(h.controller.reviewState.pendingCorrectionId, undefined);
  // The same marker turn again: consumed, never re-reviewed as a revision.
  await h.controller.onAgentEnd(correctionTurn(id), ctx);
  assert.equal(h.reviews.length, 2);
});

test("a stale/uncorrelated rv-correction marker does not activate anything", async () => {
  const h = makeHarness("always");
  await h.controller.onAgentEnd(correctionTurn("rv-cor-9-9"), ctx);
  assert.equal(h.reviews.length, 0);
});

test("a normal user turn while a correction is pending stays a normal turn", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 2 });
  h.setVerdicts([verdict("concern"), verdict("pass")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  const pendingId = h.controller.reviewState.pendingCorrectionId;
  assert.ok(pendingId);
  // User drives a brand-new turn BEFORE the hidden correction completes.
  h.setLeaf("leaf-2");
  h.setProposal("a brand-new unrelated user answer, also long enough");
  await h.controller.onAgentEnd(assistantTurn("a brand-new unrelated user answer, also long enough"), ctx);
  assert.equal(h.reviews.length, 2);
  assert.equal(h.reviews[1].activationReason, "agent_end"); // NOT a revision
  assert.equal(h.reviews[1].proposal, "a brand-new unrelated user answer, also long enough");
  assert.equal(h.controller.reviewState.pendingCorrectionId, pendingId); // still pending
});

test("unresolved after maxRevisionRounds: loop stops and asks the user", async () => {
  const h = makeHarness("always", { maxRevisionRounds: 1 });
  h.setVerdicts([verdict("concern"), verdict("concern")]);
  await h.controller.onAgentEnd(assistantTurn("a substantive answer long enough to matter"), ctx);
  await h.controller.onAgentEnd(correctionTurn(h.corrections[0].id), ctx);
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

test("buildCorrectionMessage cites findings and demands resolution", () => {
  const text = buildCorrectionMessage(verdict("fail"));
  assert.match(text, /FAIL/);
  assert.match(text, /\[high\/correctness\] 2\+2=5 — contradicts arithmetic/);
  assert.match(text, /correction: state 4/);
  assert.match(text, /Revise your answer/);
});
