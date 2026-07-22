/**
 * Compact OMP-visible status and verdict rendering.
 * Status lines follow the brief's background format (`RV · …`);
 * verdict blocks are what `/rv review` prints in full.
 */
import type { CouncilVerdict, Finding, ReviewerReceipt } from "./receipts.js";

/** One-line status for notifications while/after a review runs. */
export function renderStatusLine(verdict: CouncilVerdict): string {
  switch (verdict.status) {
    case "pass":
      return "RV · verified";
    case "concern":
      return `RV · concern found (${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"})`;
    case "fail":
      return `RV · FAIL — ${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}`;
    case "split":
      return "RV · split verdict; user decision needed";
    case "insufficient_evidence":
      return "RV · insufficient evidence to verify";
    case "review_unavailable":
      return "RV · review unavailable (no reviewer completed)";
  }
}

export function renderReviewingLine(reviewerNames: readonly string[]): string {
  return `RV · reviewing with ${reviewerNames.join(", ")}…`;
}

function renderFinding(finding: Finding, index: number): string {
  const lines = [`  ${index + 1}. [${finding.severity}/${finding.category}] ${finding.claim}`, `     → ${finding.concern}`];
  for (const evidence of finding.evidence) {
    lines.push(`     evidence: [${evidence.kind}] ${evidence.ref}${evidence.detail ? ` — ${evidence.detail}` : ""}`);
  }
  if (finding.suggestedCorrection) lines.push(`     fix: ${finding.suggestedCorrection}`);
  return lines.join("\n");
}

function renderReviewer(reviewer: ReviewerReceipt): string {
  const where = reviewer.local ? "local" : "remote";
  if (reviewer.status !== "ok") {
    return `  ✗ ${reviewer.reviewerId} (${reviewer.provider}/${reviewer.model}, ${where}) — ${reviewer.status}: ${reviewer.error ?? ""}`;
  }
  const usage = reviewer.usage?.input !== undefined ? ` · ${reviewer.usage.input}→${reviewer.usage.output ?? "?"} tok` : "";
  return `  ✓ ${reviewer.reviewerId} (${reviewer.provider}/${reviewer.model}, ${where}) → ${reviewer.verdict} · ${reviewer.latencyMs}ms${usage}`;
}

/** Full verdict block for `/rv review` output. */
export function renderVerdict(verdict: CouncilVerdict): string {
  const lines: string[] = [
    `━━━ Resolve Vector ${verdict.mode} verdict: ${verdict.status.toUpperCase()} ━━━`,
    verdict.summary,
    "",
    "Reviewers:",
    ...verdict.reviewers.map(renderReviewer),
  ];
  if (verdict.findings.length > 0) {
    lines.push("", "Findings:", ...verdict.findings.map(renderFinding));
  }
  lines.push(
    "",
    `usage: ${verdict.usage.input} in / ${verdict.usage.output} out · ${verdict.usage.totalLatencyMs}ms · id ${verdict.id}`,
  );
  return lines.join("\n");
}
