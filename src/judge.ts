/**
 * Candidate anonymization, judging, and selection.
 *
 * The judge is blind: candidates arrive as `candidate-A/B/…` after a shuffle,
 * with provider identity stripped, so position bias and vendor loyalty cannot
 * steer the verdict. Deterministic checks run BEFORE judging; a candidate
 * that fails an objective check is disqualified and cannot win no matter how
 * well it is written.
 */
import type { CheckReceipt } from "./receipts.js";

export interface GeneratedCandidate {
  /** Internal seat id — never shown to the judge. */
  seatId: string;
  text: string;
}

export interface AnonymizedCandidate {
  anonId: string;
  text: string;
  /** Internal only: maps back to the generator seat. */
  seatId: string;
}

const ANON_LABELS = "ABCDEFGH";

/**
 * Strip identity and randomize order. `rng` is injected so tests can pin the
 * permutation.
 */
export function anonymizeCandidates(
  candidates: readonly GeneratedCandidate[],
  rng: () => number,
): AnonymizedCandidate[] {
  const shuffled = [...candidates];
  // Fisher–Yates, unbiased given a fair rng.
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.map((candidate, index) => ({
    anonId: `candidate-${ANON_LABELS[index] ?? index}`,
    text: candidate.text,
    seatId: candidate.seatId,
  }));
}

export interface JudgeScores {
  intent: number;
  correctness: number;
  completeness: number;
  evidence: number;
  reasoning: number;
  constraints: number;
  practicality: number;
}

export interface ScoredCandidate {
  anonId: string;
  seatId: string;
  scores: JudgeScores;
  total: number;
  /** One-line judge rationale. */
  note?: string;
  checks: CheckReceipt[];
  disqualified: boolean;
}

export const JUDGE_SYSTEM_PROMPT = `You are a blind judge comparing independent candidate answers to the same task. You do not know which model wrote which candidate, and the order was randomized — do not try to guess origins, and do not favor position or style.

Score each candidate 0-5 on every dimension:
- intent: does it answer the actual task?
- correctness: are its claims true?
- completeness: does it cover everything the task requires?
- evidence: are claims grounded in the supplied evidence?
- reasoning: is the method sound (not just the conclusion)?
- constraints: does it satisfy every stated constraint?
- practicality: would the answer work if applied?

Be strict: confident wrong answers score LOWER than honest partial ones.

Respond with ONLY a JSON object:
{
  "scores": [
    { "candidate": "candidate-A", "intent": 0, "correctness": 0, "completeness": 0, "evidence": 0, "reasoning": 0, "constraints": 0, "practicality": 0, "note": "one line" }
  ]
}
Include every candidate exactly once.`;

export function buildJudgePrompt(
  goal: string,
  constraints: readonly string[] | undefined,
  candidates: readonly AnonymizedCandidate[],
): string {
  const parts: string[] = ["## Task", goal];
  if (constraints && constraints.length > 0) {
    parts.push("", "## Constraints", ...constraints.map((c) => `- ${c}`));
  }
  for (const candidate of candidates) {
    parts.push("", `=== ${candidate.anonId} ===`, candidate.text);
  }
  parts.push("", "Score every candidate now. JSON only.");
  return parts.join("\n");
}

const SCORE_DIMENSIONS: readonly (keyof JudgeScores)[] = [
  "intent",
  "correctness",
  "completeness",
  "evidence",
  "reasoning",
  "constraints",
  "practicality",
];

export interface ParsedJudgeScores {
  candidate: string;
  scores: JudgeScores;
  note?: string;
}

/** Parse judge output; unknown/malformed candidates are dropped, not invented. */
export function parseJudgeResponse(text: string): ParsedJudgeScores[] {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("judge returned no JSON object");
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("judge JSON unbalanced");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`judge JSON malformed: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || !("scores" in raw) || !Array.isArray(raw.scores)) {
    throw new Error("judge JSON missing scores array");
  }
  const parsed: ParsedJudgeScores[] = [];
  for (const entry of raw.scores) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("candidate" in entry) || typeof entry.candidate !== "string") continue;
    const scores = {} as JudgeScores;
    let valid = true;
    for (const dimension of SCORE_DIMENSIONS) {
      const value = dimension in entry ? entry[dimension as keyof typeof entry] : undefined;
      if (typeof value !== "number" || value < 0 || value > 5) {
        valid = false;
        break;
      }
      scores[dimension] = value;
    }
    if (!valid) continue;
    parsed.push({
      candidate: entry.candidate,
      scores,
      note: "note" in entry && typeof entry.note === "string" ? entry.note : undefined,
    });
  }
  return parsed;
}

/**
 * Deterministic-check precedence: disqualified candidates are removed from
 * contention BEFORE totals are compared. Winner = highest total among
 * qualified candidates; a tie for first is a split, not a coin flip.
 */
export function selectWinner(
  scored: readonly ScoredCandidate[],
): { outcome: "winner"; anonId: string } | { outcome: "split" } | { outcome: "none" } {
  const qualified = scored.filter((candidate) => !candidate.disqualified);
  if (qualified.length === 0) return { outcome: "none" };
  const best = Math.max(...qualified.map((candidate) => candidate.total));
  const leaders = qualified.filter((candidate) => candidate.total === best);
  if (leaders.length > 1) return { outcome: "split" };
  return { outcome: "winner", anonId: leaders[0].anonId };
}
