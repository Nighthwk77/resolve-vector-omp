/**
 * Compact OMP-visible status and verdict rendering.
 * Status lines follow the brief's background format (`RV · …`);
 * verdict blocks are what `/rv review` prints in full.
 */
import type { CouncilVerdict, Finding, ReviewerReceipt } from "./receipts.js";

/** One-line status for notifications while/after a review runs. */
export function renderStatusLine(verdict: CouncilVerdict): string {
  // Degraded coverage is never presented as fully verified.
  const degraded = verdict.coverageDegraded ? " — reduced coverage (reviewer unavailable)" : "";
  switch (verdict.status) {
    case "pass":
      return verdict.mode === "review"
        ? `RV · verified${degraded} · ${verdict.id}`
        : `RV · ${verdict.mode} complete${verdict.selectedCandidateId ? ` — ${verdict.selectedCandidateId}` : ""}${degraded} · ${verdict.id}`;
    case "concern":
      return `RV · concern found (${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"})${degraded}`;
    case "fail":
      return `RV · FAIL — ${verdict.findings.length} finding${verdict.findings.length === 1 ? "" : "s"}${degraded}`;
    case "split":
      return "RV · split verdict; user decision needed";
    case "insufficient_evidence":
      return "RV · insufficient evidence to verify";
    case "review_unavailable":
      return `RV · review unavailable (no reviewer completed) · ${verdict.id}`;
  }
}

/** Actionable detail for review_unavailable: why, and what to do next. */
export function renderUnavailableDetail(verdict: CouncilVerdict): string {
  const lines: string[] = ["RV · review unavailable — the answer was NOT verified:"];
  for (const reviewer of verdict.reviewers) {
    lines.push(`  ${renderReviewer(reviewer)}`);
  }
  const actions: string[] = [];
  if (verdict.reviewers.some((r) => r.local && r.status !== "ok")) {
    const failed = verdict.reviewers.find((r) => r.local && r.status !== "ok");
    actions.push(`restart the ${failed?.provider ?? "local"} service, then run /rv doctor probe`);
  }
  if (verdict.reviewers.some((r) => r.status === "skipped_budget")) {
    actions.push("external budget is exhausted — wait for the window to roll (see /rv status)");
  }
  if (verdict.reviewers.some((r) => r.status === "skipped_same_family")) {
    actions.push("a reviewer shares the primary model's family — switch model or add a cross-family seat");
  }
  if (verdict.reviewers.some((r) => !r.local && r.status !== "ok" && r.status !== "skipped_budget" && r.status !== "skipped_same_family")) {
    actions.push("check the remote reviewer endpoint");
  }
  actions.push("retry with /rv review once a reviewer is healthy");
  lines.push(`next: ${actions.join("; ")}.`);
  lines.push("No automatic correction will run.");
  return lines.join("\n");
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
    const category = reviewer.failureCategory ? ` [${reviewer.failureCategory}]` : "";
    return `  ✗ ${reviewer.reviewerId} (${reviewer.provider}/${reviewer.model}, ${where}) — ${reviewer.status}${category}: ${reviewer.error ?? ""}`;
  }
  const usage = reviewer.usage?.input !== undefined ? ` · ${reviewer.usage.input}→${reviewer.usage.output ?? "?"} tok` : "";
  const firstToken = reviewer.firstTokenLatencyMs !== undefined ? ` · first token ${reviewer.firstTokenLatencyMs}ms` : "";
  return `  ✓ ${reviewer.reviewerId} (${reviewer.provider}/${reviewer.model}, ${where}) → ${reviewer.verdict} · ${reviewer.latencyMs}ms${firstToken}${usage}`;
}

/** Split presentation: the competing conclusions and material disagreements. */
export function renderSplitDetail(verdict: CouncilVerdict): string {
  const lines: string[] = ["RV · split — reviewers disagree:"];
  for (const reviewer of verdict.reviewers) {
    if (reviewer.status !== "ok") continue;
    lines.push(`  ${reviewer.reviewerId} → ${reviewer.verdict}${reviewer.summary ? `: ${reviewer.summary}` : ""}`);
  }
  if (verdict.findings.length > 0) {
    lines.push("material disagreements:");
    for (const finding of verdict.findings.slice(0, 5)) {
      lines.push(`  [${finding.severity}/${finding.category}] ${finding.claim} — ${finding.concern}`);
    }
  }
  lines.push("RV takes no side. Review the positions above and decide.");
  return lines.join("\n");
}

/** Full verdict block for `/rv review` output. */
export function renderVerdict(verdict: CouncilVerdict): string {
  const lines: string[] = [
    `━━━ Resolve Vector ${verdict.mode} verdict: ${verdict.status.toUpperCase()} ━━━`,
    verdict.summary,
  ];
  if (verdict.coverageDegraded) {
    lines.push("⚠ reduced coverage — at least one reviewer failed or was skipped; verdict rests on fewer seats");
  }
  lines.push(
    "",
    "Reviewers:",
    ...verdict.reviewers.map(renderReviewer),
  );
  if (verdict.findings.length > 0) {
    lines.push("", "Findings:", ...verdict.findings.map(renderFinding));
  }
  if (verdict.candidates && verdict.candidates.length > 0) {
    lines.push("", "Candidates:");
    for (const candidate of verdict.candidates) {
      if (candidate.status !== "ok") {
        lines.push(`  ✗ ${candidate.reviewerId} — ${candidate.status}: ${candidate.error ?? ""}`);
      } else {
        lines.push(
          `  ✓ ${candidate.anonId} (${candidate.reviewerId}) — ${candidate.total ?? "?"}/35${candidate.disqualified ? " DISQUALIFIED" : ""} · ${candidate.latencyMs}ms`,
        );
      }
    }
  }
  lines.push(
    "",
    `usage: ${verdict.usage.input} in / ${verdict.usage.output} out · ${verdict.usage.totalLatencyMs}ms · id ${verdict.id}`,
  );
  return lines.join("\n");
}
