/**
 * Default reasoning-review profile: prompt construction and verdict parsing
 * for the `review` council mode over arbitrary agent work.
 *
 * The reviewer gets the goal, the primary answer, and optional evidence, and
 * must return one JSON object. Parsing is lenient about prose around the JSON
 * but strict about the verdict shape.
 */
import type { EvidenceItem, Finding, VerdictStatus } from "../receipts.js";

export interface ReviewRequest {
  goal: string;
  proposal: string;
  evidence?: EvidenceItem[];
  constraints?: string[];
}

export interface ParsedReview {
  status: VerdictStatus;
  summary: string;
  findings: Finding[];
}

const VALID_STATUSES: Record<VerdictStatus, true> = {
  pass: true,
  concern: true,
  fail: true,
  split: true,
  insufficient_evidence: true,
  review_unavailable: true,
};

const VALID_SEVERITIES: Record<Finding["severity"], true> = {
  info: true,
  low: true,
  medium: true,
  high: true,
  critical: true,
};

const VALID_CATEGORIES: Record<Finding["category"], true> = {
  intent: true,
  correctness: true,
  method: true,
  assumption: true,
  evidence: true,
  edge_case: true,
  constraint: true,
  security: true,
  other: true,
};

export const GENERIC_REVIEW_SYSTEM_PROMPT = `You are an independent reviewer auditing another AI model's completed work. You are from a different model family specifically so your blind spots differ — distrust the answer's framing and check its reasoning, not just its conclusions.

Review the METHOD, not only the outcome: a right answer reached by wrong reasoning is still wrong, because it breaks the moment the situation changes.

Rules:
- Challenge specific claims with specific evidence. No generic second opinions.
- Cite the exact claim you dispute and why it fails.
- Distinguish objective errors (contradictions, violated constraints, missing mandatory evidence) from subjective disagreement.
- If the work is sound, say so. Do not manufacture findings.

Respond with ONLY a JSON object, no prose, in this exact shape:
{
  "status": "pass" | "concern" | "fail" | "insufficient_evidence",
  "summary": "one or two sentences",
  "findings": [
    {
      "severity": "info" | "low" | "medium" | "high" | "critical",
      "category": "intent" | "correctness" | "method" | "assumption" | "evidence" | "edge_case" | "constraint" | "security" | "other",
      "claim": "the specific claim challenged",
      "concern": "why it is wrong or risky",
      "evidence": [{ "kind": "file" | "quote" | "url" | "tool_output" | "other", "ref": "...", "detail": "..." }],
      "suggestedCorrection": "optional fix"
    }
  ]
}
Use "fail" only for objective errors: contradictions, violated constraints, missing mandatory evidence. Use "concern" for material reasoning issues. "pass" means you tried to break it and could not.`;

/* ─────────────────────── bounded review input ─────────────────────── */

const GOAL_CAP_CHARS = 4_000;
const CONSTRAINT_CAP_CHARS = 500;
const MAX_CONSTRAINTS = 20;
const EVIDENCE_FIELD_CAP_CHARS = 500;
const MAX_EVIDENCE_ITEMS = 20;
/** Scaffolding (headers, instructions) reserved on top of field content. */
const PROMPT_OVERHEAD_CHARS = 400;

export interface BoundedReviewRequest {
  request: ReviewRequest;
  /** True when any field was capped or an item was dropped. */
  truncated: boolean;
}

function capText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n[RV: truncated — ${text.length - limit} chars omitted to bound review context]`,
    truncated: true,
  };
}

/**
 * Bound a review request to maxChars of prompt content. Only the review
 * goal, completed answer, evidence, and constraints are ever sent — never
 * the whole conversation. Truncation is explicit: markers go INTO the
 * prompt (so the reviewer knows) and `truncated` goes into the receipt.
 */
export function boundReviewRequest(request: ReviewRequest, maxChars: number): BoundedReviewRequest {
  let truncated = false;

  const goal = capText(request.goal, GOAL_CAP_CHARS);
  truncated ||= goal.truncated;

  const constraints: string[] = [];
  for (const constraint of (request.constraints ?? []).slice(0, MAX_CONSTRAINTS)) {
    const capped = capText(constraint, CONSTRAINT_CAP_CHARS);
    truncated ||= capped.truncated;
    constraints.push(capped.text);
  }
  const droppedConstraints = (request.constraints?.length ?? 0) - constraints.length;
  if (droppedConstraints > 0) {
    truncated = true;
    constraints.push(`[RV: ${droppedConstraints} further constraints omitted to bound review context]`);
  }

  const evidence: EvidenceItem[] = [];
  for (const item of (request.evidence ?? []).slice(0, MAX_EVIDENCE_ITEMS)) {
    const ref = capText(item.ref, EVIDENCE_FIELD_CAP_CHARS);
    const detail = item.detail === undefined ? undefined : capText(item.detail, EVIDENCE_FIELD_CAP_CHARS);
    truncated ||= ref.truncated || (detail?.truncated ?? false);
    evidence.push({ kind: item.kind, ref: ref.text, detail: detail?.text });
  }
  const droppedEvidence = (request.evidence?.length ?? 0) - evidence.length;
  if (droppedEvidence > 0) {
    truncated = true;
    evidence.push({ kind: "other", ref: `[RV: ${droppedEvidence} further evidence items omitted to bound review context]` });
  }

  const used =
    PROMPT_OVERHEAD_CHARS +
    goal.text.length +
    constraints.reduce((sum, c) => sum + c.length + 2, 0) +
    evidence.reduce((sum, e) => sum + e.ref.length + (e.detail?.length ?? 0) + 12, 0);
  const proposalBudget = Math.max(1_000, maxChars - used);
  const proposal = capText(request.proposal, proposalBudget);
  truncated ||= proposal.truncated;

  return {
    request: {
      goal: goal.text,
      proposal: proposal.text,
      constraints: constraints.length > 0 ? constraints : undefined,
      evidence: evidence.length > 0 ? evidence : undefined,
    },
    truncated,
  };
}

export function buildReviewPrompt(request: ReviewRequest): string {
  const parts: string[] = [
    "## Goal under review",
    request.goal,
    "",
    "## Completed answer / action",
    request.proposal,
  ];
  if (request.constraints && request.constraints.length > 0) {
    parts.push("", "## Constraints the answer must satisfy", ...request.constraints.map((c) => `- ${c}`));
  }
  if (request.evidence && request.evidence.length > 0) {
    parts.push("", "## Evidence supplied");
    for (const item of request.evidence) {
      parts.push(`- [${item.kind}] ${item.ref}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  parts.push("", "Audit this work now. JSON only.");
  return parts.join("\n");
}

function toEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const items: EvidenceItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.ref !== "string" || record.ref.length === 0) continue;
    const kind = typeof record.kind === "string" && ["file", "quote", "url", "tool_output", "other"].includes(record.kind)
      ? (record.kind as EvidenceItem["kind"])
      : "other";
    items.push({ kind, ref: record.ref, detail: typeof record.detail === "string" ? record.detail : undefined });
  }
  return items;
}

function toFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const findings: Finding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.claim !== "string" || typeof record.concern !== "string") continue;
    findings.push({
      severity: typeof record.severity === "string" && VALID_SEVERITIES[record.severity as Finding["severity"]]
        ? (record.severity as Finding["severity"])
        : "medium",
      category: typeof record.category === "string" && VALID_CATEGORIES[record.category as Finding["category"]]
        ? (record.category as Finding["category"])
        : "other",
      claim: record.claim,
      concern: record.concern,
      evidence: toEvidence(record.evidence),
      suggestedCorrection: typeof record.suggestedCorrection === "string" ? record.suggestedCorrection : undefined,
    });
  }
  return findings;
}

/** Extract the first balanced {...} block, tolerating prose and code fences. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
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
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse a reviewer response into a verdict. Throws on unrecoverable shape. */
export function parseReviewResponse(text: string): ParsedReview {
  const json = extractJsonObject(text);
  if (!json) throw new Error("reviewer returned no JSON object");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`reviewer JSON malformed: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("reviewer JSON is not an object");
  const record = raw as Record<string, unknown>;
  const status = typeof record.status === "string" && VALID_STATUSES[record.status as VerdictStatus]
    ? (record.status as VerdictStatus)
    : undefined;
  if (!status || status === "review_unavailable") {
    throw new Error(`reviewer returned invalid status: ${String(record.status)}`);
  }
  return {
    status,
    summary: typeof record.summary === "string" ? record.summary : "",
    findings: toFindings(record.findings),
  };
}
