/**
 * Conflict-aware fusion (brief §7): never an average. The fusion model must
 * extract what the candidates agree on, name every material disagreement,
 * resolve conflicts with evidence where possible, and leave the rest
 * explicitly unresolved. The fused answer then passes one final independent
 * review before it ships.
 */

export interface FusionClaim {
  text: string;
  /** Anonymized candidate ids backing this claim. */
  supporters: string[];
}

export interface FusionConflict {
  topic: string;
  positions: { candidate: string; claim: string }[];
}

export interface SelectedClaim extends FusionClaim {
  /** Why this position won: evidence citation or constraint reference. */
  basis: string;
}

export interface FusionPlan {
  agreements: FusionClaim[];
  conflicts: FusionConflict[];
  selectedClaims: SelectedClaim[];
  unresolved: FusionConflict[];
  finalAnswer: string;
}

export const FUSION_SYSTEM_PROMPT = `You are a synthesis engine combining several independent answers to the same task. This is NOT averaging and NOT voting.

Method:
1. AGREEMENTS: claims every candidate (or all but one) makes — these are the backbone.
2. CONFLICTS: every material point where candidates disagree. Name who claims what (by candidate id).
3. RESOLUTION: for each conflict, pick the position the EVIDENCE or CONSTRAINTS support, and state that basis. If no evidence settles it, move it to unresolved — do not guess.
4. Compose the final answer from agreements + resolved claims only. If a conflict is unresolved, the final answer must flag it openly instead of silently choosing.

Respond with ONLY a JSON object:
{
  "agreements": [{ "text": "...", "supporters": ["candidate-A"] }],
  "conflicts": [{ "topic": "...", "positions": [{ "candidate": "candidate-A", "claim": "..." }] }],
  "selectedClaims": [{ "text": "...", "supporters": ["candidate-B"], "basis": "evidence: <ref> | constraint: <name> | reasoning: <why>" }],
  "unresolved": [{ "topic": "...", "positions": [{ "candidate": "candidate-A", "claim": "..." }] }],
  "finalAnswer": "the fused answer; every unresolved conflict explicitly flagged"
}`;

export function buildFusionPrompt(
  goal: string,
  constraints: readonly string[] | undefined,
  candidates: readonly { anonId: string; text: string }[],
): string {
  const parts: string[] = ["## Task", goal];
  if (constraints && constraints.length > 0) {
    parts.push("", "## Constraints", ...constraints.map((c) => `- ${c}`));
  }
  for (const candidate of candidates) {
    parts.push("", `=== ${candidate.anonId} ===`, candidate.text);
  }
  parts.push("", "Extract, reconcile, and fuse now. JSON only.");
  return parts.join("\n");
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

function toClaims(raw: unknown): FusionClaim[] {
  if (!Array.isArray(raw)) return [];
  const claims: FusionClaim[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("text" in entry) || typeof entry.text !== "string") continue;
    claims.push({ text: entry.text, supporters: "supporters" in entry ? toStringArray(entry.supporters) : [] });
  }
  return claims;
}

function toConflicts(raw: unknown): FusionConflict[] {
  if (!Array.isArray(raw)) return [];
  const conflicts: FusionConflict[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("topic" in entry) || typeof entry.topic !== "string") continue;
    const positions: FusionConflict["positions"] = [];
    if ("positions" in entry && Array.isArray(entry.positions)) {
      for (const position of entry.positions) {
        if (typeof position !== "object" || position === null) continue;
        if (!("candidate" in position) || typeof position.candidate !== "string") continue;
        if (!("claim" in position) || typeof position.claim !== "string") continue;
        positions.push({ candidate: position.candidate, claim: position.claim });
      }
    }
    conflicts.push({ topic: entry.topic, positions });
  }
  return conflicts;
}

/** Parse fusion output. Throws when the shape is unrecoverable. */
export function parseFusionPlan(text: string): FusionPlan {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("fusion returned no JSON object");
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
  if (end < 0) throw new Error("fusion JSON unbalanced");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`fusion JSON malformed: ${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new Error("fusion JSON is not an object");
  if (!("finalAnswer" in raw) || typeof raw.finalAnswer !== "string" || raw.finalAnswer.trim().length === 0) {
    throw new Error("fusion JSON missing finalAnswer");
  }
  const selectedClaims: SelectedClaim[] = [];
  if ("selectedClaims" in raw && Array.isArray(raw.selectedClaims)) {
    for (const entry of raw.selectedClaims) {
      if (typeof entry !== "object" || entry === null) continue;
      if (!("text" in entry) || typeof entry.text !== "string") continue;
      if (!("basis" in entry) || typeof entry.basis !== "string") continue;
      selectedClaims.push({
        text: entry.text,
        supporters: "supporters" in entry ? toStringArray(entry.supporters) : [],
        basis: entry.basis,
      });
    }
  }
  return {
    agreements: "agreements" in raw ? toClaims(raw.agreements) : [],
    conflicts: "conflicts" in raw ? toConflicts(raw.conflicts) : [],
    selectedClaims,
    unresolved: "unresolved" in raw ? toConflicts(raw.unresolved) : [],
    finalAnswer: raw.finalAnswer,
  };
}
