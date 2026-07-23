import { test } from "node:test";
import assert from "node:assert/strict";
import { CANDIDATE_SYSTEM_PROMPT } from "../src/candidates.js";
import { runEnsemble, type EnsembleDeps } from "../src/council.js";
import { GENERIC_REVIEW_SYSTEM_PROMPT } from "../src/domain/generic.js";
import { FUSION_SYSTEM_PROMPT } from "../src/fusion.js";
import {
  anonymizeCandidates,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeResponse,
  selectWinner,
  type ScoredCandidate,
} from "../src/judge.js";
import { parseFusionPlan } from "../src/fusion.js";
import { DEFAULT_CONFIG, type ResolveVectorConfig, type ReviewerConfig } from "../src/policy.js";
import type { ResolveResult, ResolvedReviewer } from "../src/providers.js";
import type { CheckReceipt } from "../src/receipts.js";

const seat = (id: string, role: ReviewerConfig["role"] = "critic", local = true): ReviewerConfig => ({
  id,
  provider: `p-${id}`,
  model: `m-${id}`,
  family: `fam-${id}`,
  role,
  local,
  enabled: true,
  order: 1,
});

function configWith(reviewers: ReviewerConfig[], overrides: Partial<ResolveVectorConfig> = {}): ResolveVectorConfig {
  return { ...DEFAULT_CONFIG, reviewers, ...overrides };
}

function okResolution(config: ReviewerConfig): ResolveResult {
  const reviewer = {
    config,
    model: { provider: config.provider, id: config.model },
    family: config.family,
    apiKey: undefined,
  } as unknown as ResolvedReviewer;
  return { ok: true, reviewer };
}

const judgeJson = (scores: { candidate: string; total?: number; note?: string; dims?: Partial<Record<string, number>> }[]) =>
  JSON.stringify({
    scores: scores.map((s) => ({
      candidate: s.candidate,
      intent: 4,
      correctness: 4,
      completeness: 4,
      evidence: 4,
      reasoning: 4,
      constraints: 4,
      practicality: 4,
      ...(s.dims ?? {}),
      note: s.note ?? "ok",
    })),
  });

test("anonymizeCandidates strips identity and assigns anon ids over a shuffled order", () => {
  const candidates = [
    { seatId: "seat-one", text: "one" },
    { seatId: "seat-two", text: "two" },
    { seatId: "seat-three", text: "three" },
  ];
  // Pinned rng → deterministic reverse rotation.
  const rolls = [0.9, 0.5, 0.1];
  const anon = anonymizeCandidates(candidates, () => rolls.shift() ?? 0);
  assert.equal(anon.length, 3);
  assert.ok(anon.every((c) => /^candidate-[ABC]$/.test(c.anonId)));
  assert.deepEqual(
    anon.map((c) => c.seatId).sort(),
    ["seat-one", "seat-three", "seat-two"],
  );
  // The permutation is a genuine shuffle of the input order.
  expectPermutation(anon.map((c) => c.seatId), ["seat-one", "seat-two", "seat-three"]);
});

function expectPermutation(actual: string[], original: string[]): void {
  assert.deepEqual([...actual].sort(), [...original].sort());
}

test("anonymizeCandidates produces different orders for different rng streams", () => {
  const candidates = Array.from({ length: 4 }, (_, i) => ({ seatId: `s${i}`, text: `t${i}` }));
  const a = anonymizeCandidates(candidates, () => 0.1).map((c) => c.seatId).join(",");
  const b = anonymizeCandidates(candidates, () => 0.9).map((c) => c.seatId).join(",");
  assert.notEqual(a, b);
});

test("parseJudgeResponse tolerates prose and drops malformed entries", () => {
  const parsed = parseJudgeResponse(
    `Here you go:\n${judgeJson([{ candidate: "candidate-A" }, { candidate: "candidate-B", dims: { correctness: 1 } }])}\nthanks`,
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].scores.correctness, 1);
  assert.throws(() => parseJudgeResponse("no json"), /no JSON object/);
  const dropped = parseJudgeResponse(
    JSON.stringify({ scores: [{ candidate: "candidate-A", intent: 9, correctness: 4, completeness: 4, evidence: 4, reasoning: 4, constraints: 4, practicality: 4 }] }),
  );
  assert.equal(dropped.length, 0); // out-of-range score → entry dropped
});

test("selectWinner: deterministic checks beat judge preference", () => {
  const scored: ScoredCandidate[] = [
    {
      anonId: "candidate-A",
      seatId: "s1",
      scores: { intent: 5, correctness: 5, completeness: 5, evidence: 5, reasoning: 5, constraints: 5, practicality: 5 },
      total: 35,
      checks: [{ name: "coefficient", passed: false, detail: "wrong constant" }],
      disqualified: true,
    },
    {
      anonId: "candidate-B",
      seatId: "s2",
      scores: { intent: 3, correctness: 3, completeness: 3, evidence: 3, reasoning: 3, constraints: 3, practicality: 3 },
      total: 21,
      checks: [],
      disqualified: false,
    },
  ];
  // A outscores B everywhere but fails the objective check — B must win.
  assert.deepEqual(selectWinner(scored), { outcome: "winner", anonId: "candidate-B" });
  assert.equal(selectWinner([]).outcome, "none");
  const tied = scored.map((s) => ({ ...s, disqualified: false, total: 21 }));
  assert.equal(selectWinner(tied).outcome, "split");
});

interface EnsembleHarness {
  deps: EnsembleDeps;
  judgePrompts: string[];
  calls: { seatId: string; system: string }[];
}

function makeEnsembleDeps(options: {
  candidateTexts: Record<string, string>;
  judgeText?: string;
  fusionText?: string;
  reviewText?: string;
  checks?: (candidate: { anonId: string; text: string }) => CheckReceipt[];
  rng?: () => number;
}): EnsembleHarness {
  const judgePrompts: string[] = [];
  const calls: { seatId: string; system: string }[] = [];
  const deps: EnsembleDeps = {
    resolveReviewer: async (config) => okResolution(config),
    complete: async (resolved, system, prompt) => {
      calls.push({ seatId: resolved.config.id, system });
      if (system === CANDIDATE_SYSTEM_PROMPT) {
        return { text: options.candidateTexts[resolved.config.id] ?? `answer from ${resolved.config.id}` };
      }
      if (system === JUDGE_SYSTEM_PROMPT) {
        judgePrompts.push(prompt);
        return { text: options.judgeText ?? judgeJson([{ candidate: "candidate-A" }, { candidate: "candidate-B" }]) };
      }
      if (system === FUSION_SYSTEM_PROMPT) {
        return {
          text:
            options.fusionText ??
            JSON.stringify({
              agreements: [{ text: "shared truth", supporters: ["candidate-A", "candidate-B"] }],
              conflicts: [],
              selectedClaims: [],
              unresolved: [],
              finalAnswer: "the fused answer",
            }),
        };
      }
      if (system === GENERIC_REVIEW_SYSTEM_PROMPT) {
        return { text: options.reviewText ?? JSON.stringify({ status: "pass", summary: "sound", findings: [] }) };
      }
      throw new Error(`unexpected system prompt: ${system.slice(0, 40)}`);
    },
    checks: options.checks,
    rng: options.rng,
  };
  return { deps, judgePrompts, calls };
}

const baseEnsemble = {
  mode: "best" as const,
  goal: "design the thing",
  candidateCount: 2,
};

test("runEnsemble best: judge prompt is blind (no seat identity leaks)", async () => {
  const h = makeEnsembleDeps({
    candidateTexts: { "gen-1": "alpha answer", "gen-2": "beta answer" },
    judgeText: JSON.stringify({
      scores: [
        { candidate: "candidate-A", intent: 5, correctness: 5, completeness: 5, evidence: 5, reasoning: 5, constraints: 5, practicality: 5, note: "strong" },
        { candidate: "candidate-B", intent: 2, correctness: 2, completeness: 2, evidence: 2, reasoning: 2, constraints: 2, practicality: 2, note: "weak" },
      ],
    }),
  });
  const verdict = await runEnsemble({
    ...baseEnsemble,
    config: configWith([seat("gen-1"), seat("gen-2")]),
    deps: h.deps,
  });
  assert.equal(verdict.status, "pass");
  assert.equal(h.judgePrompts.length, 1);
  const prompt = h.judgePrompts[0];
  assert.ok(!prompt.includes("gen-1") && !prompt.includes("gen-2"), "seat ids must not leak to the judge");
  assert.ok(!prompt.includes("p-gen-1") && !prompt.includes("fam-gen-1"), "provider/family must not leak");
  assert.match(prompt, /candidate-A/);
  assert.match(prompt, /candidate-B/);
  assert.match(prompt, /alpha answer|beta answer/);
  assert.ok(verdict.selectedCandidateId);
  assert.equal(verdict.candidates?.length, 2);
  assert.ok(verdict.candidates?.every((c) => c.anonId.startsWith("candidate-")));
});

test("runEnsemble best: a disqualified favorite cannot win (check precedence, end to end)", async () => {
  const h = makeEnsembleDeps({
    candidateTexts: { "gen-1": "bad but eloquent", "gen-2": "plain but correct" },
    // Judge LOVES candidate-A (35/35) and hates B (7/35)…
    judgeText: JSON.stringify({
      scores: [
        { candidate: "candidate-A", intent: 5, correctness: 5, completeness: 5, evidence: 5, reasoning: 5, constraints: 5, practicality: 5, note: "brilliant" },
        { candidate: "candidate-B", intent: 1, correctness: 1, completeness: 1, evidence: 1, reasoning: 1, constraints: 1, practicality: 1, note: "meh" },
      ],
    }),
    // …but candidate-A fails the objective check.
    checks: (candidate) => [{ name: "objective", passed: candidate.text !== "bad but eloquent", detail: "wrong answer" }],
    rng: () => 0.999, // identity permutation: gen-1 → candidate-A
  });
  const verdict = await runEnsemble({
    ...baseEnsemble,
    config: configWith([seat("gen-1"), seat("gen-2")]),
    deps: h.deps,
  });
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.selectedCandidateId, "candidate-B"); // the 7/35 candidate wins
  assert.equal(verdict.finalAnswer, "plain but correct");
  assert.ok(verdict.findings.some((f) => f.claim.includes("failed objective check")));
  const a = verdict.candidates?.find((c) => c.anonId === "candidate-A");
  assert.equal(a?.disqualified, true);
});

test("runEnsemble fusion: unresolved conflicts are preserved in the verdict", async () => {
  const h = makeEnsembleDeps({
    candidateTexts: { "gen-1": "use postgres", "gen-2": "use sqlite" },
    fusionText: JSON.stringify({
      agreements: [{ text: "needs durable storage", supporters: ["candidate-A", "candidate-B"] }],
      conflicts: [
        {
          topic: "storage engine",
          positions: [
            { candidate: "candidate-A", claim: "postgres" },
            { candidate: "candidate-B", claim: "sqlite" },
          ],
        },
      ],
      selectedClaims: [{ text: "durable storage", supporters: ["candidate-A", "candidate-B"], basis: "reasoning: universal agreement" }],
      unresolved: [
        {
          topic: "storage engine",
          positions: [
            { candidate: "candidate-A", claim: "postgres" },
            { candidate: "candidate-B", claim: "sqlite" },
          ],
        },
      ],
      finalAnswer: "Durable storage required; the engine choice (postgres vs sqlite) is UNRESOLVED.",
    }),
  });
  const verdict = await runEnsemble({
    ...baseEnsemble,
    mode: "fusion",
    config: configWith([seat("gen-1"), seat("gen-2")]),
    deps: h.deps,
  });
  assert.equal(verdict.status, "pass"); // final independent review passed
  assert.match(verdict.finalAnswer ?? "", /UNRESOLVED/);
  const unresolved = verdict.findings.find((f) => f.claim.includes("unresolved conflict"));
  assert.ok(unresolved, "unresolved conflict must surface as a finding");
  assert.match(unresolved.concern, /postgres/);
  assert.match(unresolved.concern, /sqlite/);
  // The final review ran: a review-mode call happened after fusion.
  assert.ok(h.calls.some((c) => c.system === GENERIC_REVIEW_SYSTEM_PROMPT));
});

test("runEnsemble compare: completes without selecting a winner", async () => {
  const h = makeEnsembleDeps({ candidateTexts: { "gen-1": "path one", "gen-2": "path two" } });
  const verdict = await runEnsemble({
    ...baseEnsemble,
    mode: "compare",
    config: configWith([seat("gen-1"), seat("gen-2")]),
    deps: h.deps,
  });
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.selectedCandidateId, undefined);
  assert.equal(verdict.finalAnswer, undefined);
  assert.ok(verdict.summary.includes("candidate-A") && verdict.summary.includes("candidate-B"));
});

test("runEnsemble fails closed with fewer than two runnable seats", async () => {
  const h = makeEnsembleDeps({ candidateTexts: {} });
  const verdict = await runEnsemble({
    ...baseEnsemble,
    config: configWith([seat("gen-1"), { ...seat("gen-2"), enabled: false }]),
    deps: h.deps,
  });
  assert.equal(verdict.status, "review_unavailable");
  assert.match(verdict.summary, /at least 2/);
});

test("runEnsemble: external seats reserve budget per call (generation + judge)", async () => {
  const reservations: number[] = [];
  const h = makeEnsembleDeps({
    candidateTexts: {},
    judgeText: JSON.stringify({
      scores: [
        { candidate: "candidate-A", intent: 5, correctness: 5, completeness: 5, evidence: 5, reasoning: 5, constraints: 5, practicality: 5, note: "strong" },
        { candidate: "candidate-B", intent: 2, correctness: 2, completeness: 2, evidence: 2, reasoning: 2, constraints: 2, practicality: 2, note: "weak" },
      ],
    }),
  });
  const remote = [seat("gen-1", "critic", false), seat("gen-2", "critic", false)];
  const verdict = await runEnsemble({
    ...baseEnsemble,
    config: configWith(remote, { maxExternalAuditsPerHour: 3 }),
    deps: {
      ...h.deps,
      budget: {
        tryReserve: (now: number) => {
          reservations.push(now);
          return { allowed: reservations.length <= 3 };
        },
      },
    },
  });
  // 2 generations + 1 judge = 3 external calls, all reserved before dispatch.
  assert.equal(reservations.length, 3);
  assert.equal(verdict.status, "pass");
});

test("parseFusionPlan requires finalAnswer and preserves structure", () => {
  assert.throws(() => parseFusionPlan(JSON.stringify({ agreements: [] })), /finalAnswer/);
  const plan = parseFusionPlan(
    JSON.stringify({
      agreements: [{ text: "a", supporters: ["candidate-A"] }],
      conflicts: [{ topic: "t", positions: [{ candidate: "candidate-A", claim: "x" }] }],
      selectedClaims: [{ text: "s", supporters: ["candidate-B"], basis: "evidence: f.cpp:1" }],
      unresolved: [{ topic: "u", positions: [] }],
      finalAnswer: "fused",
    }),
  );
  assert.equal(plan.agreements.length, 1);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.selectedClaims[0].basis, "evidence: f.cpp:1");
  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.finalAnswer, "fused");
});
