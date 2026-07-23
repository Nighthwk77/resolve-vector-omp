/**
 * Independent candidate generation for ensemble modes.
 *
 * Candidates are generated in ISOLATION — each generator sees only the goal,
 * constraints, and evidence, never another candidate, so they cannot anchor
 * on each other. Generation uses the same reviewer roster (cross-vendor by
 * configuration), but the judge never learns which seat produced which text.
 */
import type { EvidenceItem } from "./receipts.js";

export interface CandidateRequest {
  goal: string;
  constraints?: string[];
  evidence?: EvidenceItem[];
}

export const CANDIDATE_SYSTEM_PROMPT = `You are one of several independent solvers given the same task. You cannot see the other solvers' work.

Produce your best direct answer to the task:
- Answer the task itself, not questions about the task. No meta-commentary ("as an AI", "I would approach this by").
- Commit to concrete positions. Do not hedge across every alternative.
- If constraints are given, satisfy every one of them explicitly.
- If evidence is given, ground your answer in it and cite it.
- Be complete but do not pad.`;

export function buildCandidatePrompt(request: CandidateRequest): string {
  const parts: string[] = ["## Task", request.goal];
  if (request.constraints && request.constraints.length > 0) {
    parts.push("", "## Constraints (all mandatory)", ...request.constraints.map((c) => `- ${c}`));
  }
  if (request.evidence && request.evidence.length > 0) {
    parts.push("", "## Evidence to use");
    for (const item of request.evidence) {
      parts.push(`- [${item.kind}] ${item.ref}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  parts.push("", "Produce your answer now.");
  return parts.join("\n");
}
