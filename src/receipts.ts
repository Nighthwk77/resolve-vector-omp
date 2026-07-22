/**
 * Verdict schemas, JSONL persistence, and secret redaction.
 *
 * Receipts append to `<agent dir>/resolve-vector.receipts.jsonl`. They are the
 * durable record for `/rv status`, budget accounting, and auditability.
 * Secrets are redacted before anything is persisted.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CouncilMode } from "./policy.js";

/** Reviewer statuses that mean the provider actually saw traffic. */
const DISPATCHED_STATUSES: Record<string, true> = { ok: true, error: true, timeout: true };

export type VerdictStatus = "pass" | "concern" | "fail" | "split" | "insufficient_evidence" | "review_unavailable";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type FindingCategory =
  | "intent"
  | "correctness"
  | "method"
  | "assumption"
  | "evidence"
  | "edge_case"
  | "constraint"
  | "security"
  | "other";

export interface EvidenceItem {
  /** What this evidence is: file path, quoted line, URL, tool output, … */
  kind: "file" | "quote" | "url" | "tool_output" | "other";
  ref: string;
  detail?: string;
}

export interface Finding {
  severity: FindingSeverity;
  category: FindingCategory;
  claim: string;
  concern: string;
  evidence: EvidenceItem[];
  suggestedCorrection?: string;
}

export interface ReviewerReceipt {
  reviewerId: string;
  provider: string;
  model: string;
  family: string;
  local: boolean;
  status: "ok" | "skipped_budget" | "skipped_same_family" | "error" | "timeout";
  /** Provider calls made: 1 normally, 2 when the repair retry fired. Budget accounting uses this. */
  calls?: number;
  verdict?: VerdictStatus;
  findings: Finding[];
  summary?: string;
  latencyMs: number;
  usage?: { input?: number; output?: number };
  error?: string;
}

export interface CheckReceipt {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface UsageReceipt {
  input: number;
  output: number;
  totalLatencyMs: number;
}

export interface CouncilVerdict {
  id: string;
  mode: CouncilMode;
  status: VerdictStatus;
  summary: string;
  findings: Finding[];
  selectedCandidateId?: string;
  finalAnswer?: string;
  reviewers: ReviewerReceipt[];
  deterministicChecks: CheckReceipt[];
  usage: UsageReceipt;
  createdAt: string;
}

/** Durable JSONL record: verdict plus the session/budget context §12 requires. */
export interface ReviewReceipt {
  receiptId: string;
  sessionId?: string;
  turnId?: string;
  activationReason: "manual_command" | "tool_call" | "agent_end" | "revision";
  revisionRound: number;
  primaryFamily?: string;
  verdict: CouncilVerdict;
}

let receiptCounter = 0;

export function newReceiptId(now: number): string {
  receiptCounter += 1;
  return `rv-${now.toString(36)}-${receiptCounter.toString(36)}`;
}

/**
 * Deterministic secret redaction, applied before transport and before logging.
 * Covers API-key shapes, bearer tokens, and Authorization headers.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(sk|pk|key|token|api|apikey|secret|bearer|password|passwd|authorization)[-_]?[A-Za-z0-9]{16,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk|pk)-(live|test|proj|ant|admin)?-?[A-Za-z0-9_-]{12,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{24,}/g, // JWT
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Deep-redact a receipt-shaped value: every string field passes the filter. */
export function redactReceipt<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactReceipt(item)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactReceipt(entry);
    }
    return out as T;
  }
  return value;
}

/** Append one redacted receipt line. Creates the directory lazily. */
export async function appendReceipt(path: string, receipt: ReviewReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(redactReceipt(receipt))}\n`;
  await appendFile(path, line, "utf8");
}

/** Read all receipts, newest last. Malformed lines are skipped, not fatal. */
export async function readReceipts(path: string): Promise<ReviewReceipt[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const receipts: ReviewReceipt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReviewReceipt;
      if (parsed && typeof parsed.receiptId === "string" && parsed.verdict) receipts.push(parsed);
    } catch {
      // Corrupt line: skip. Receipts are an audit log, not a database.
    }
  }
  return receipts;
}

/**
 * Budget units consumed by past external reviewer traffic, as timestamps
 * (one per unit). Counts every dispatched call — attempts, failures, timeouts,
 * and repair retries — because the provider saw all of them. Skipped reviewers
 * (budget/same-family) never touched the wire and cost nothing.
 */
export function externalCallUnits(receipts: readonly ReviewReceipt[]): number[] {
  const units: number[] = [];
  for (const receipt of receipts) {
    const at = Date.parse(receipt.verdict.createdAt);
    if (Number.isNaN(at)) continue;
    for (const reviewer of receipt.verdict.reviewers) {
      if (reviewer.local || !DISPATCHED_STATUSES[reviewer.status]) continue;
      const calls = reviewer.calls ?? 1;
      for (let i = 0; i < calls; i++) units.push(at);
    }
  }
  return units;
}
