/**
 * The model-callable `council_audit` tool. Milestone 1 implements `review`;
 * ensemble modes are declared in the schema now (stable contract) and return a
 * clear unavailable-error until Milestone 3.
 *
 * Parameters use the injected TypeBox shim: zod schemas type-check against
 * omp's TSchema via a structural path that explodes (TS2589), the shim is the
 * native route. The wire-validated params are still parsed defensively here
 * because Static<ArkSchema> is unknown.
 *
 * Schema contract: `evidence` is implemented (flows into the review prompt).
 * `profile` is deliberately ABSENT — domain profiles land with
 * source-faithfulness (Milestone 4); a caller passing one gets a clear error.
 */
import type { AgentToolResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { EvidenceItem } from "./receipts.js";
import { renderStatusLine, renderVerdict } from "./render.js";
import type { RVEngine } from "./runtime.js";

interface CouncilAuditParams {
  mode: string;
  goal: string;
  proposal?: string;
  constraints?: string[];
  evidence?: EvidenceItem[];
  candidateCount?: number;
}

const EVIDENCE_KINDS: Record<EvidenceItem["kind"], true> = {
  file: true,
  quote: true,
  url: true,
  tool_output: true,
  other: true,
};

/** Defensive parse with a readable error for the model. */
function parseParams(raw: unknown): CouncilAuditParams | string {
  if (typeof raw !== "object" || raw === null) return "params must be an object";
  if ("profile" in raw) {
    return "params.profile is not supported: only the generic profile exists today (domain profiles land in Milestone 4). Remove it and retry.";
  }
  if (!("mode" in raw) || typeof raw.mode !== "string") return "params.mode: required string";
  if (!("goal" in raw) || typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
    return "params.goal: required non-empty string";
  }
  const params: CouncilAuditParams = { mode: raw.mode, goal: raw.goal };
  if ("proposal" in raw && typeof raw.proposal === "string") params.proposal = raw.proposal;
  if ("constraints" in raw && Array.isArray(raw.constraints)) {
    params.constraints = raw.constraints.filter((c): c is string => typeof c === "string");
  }
  if ("candidateCount" in raw) {
    if (typeof raw.candidateCount !== "number" || !Number.isInteger(raw.candidateCount) || raw.candidateCount < 2 || raw.candidateCount > 8) {
      return "params.candidateCount: must be an integer 2-8";
    }
    params.candidateCount = raw.candidateCount;
  }
  if ("evidence" in raw && Array.isArray(raw.evidence)) {
    const evidence: EvidenceItem[] = [];
    for (const entry of raw.evidence) {
      if (typeof entry !== "object" || entry === null || !("ref" in entry) || typeof entry.ref !== "string") continue;
      const kind = "kind" in entry && typeof entry.kind === "string" && EVIDENCE_KINDS[entry.kind as EvidenceItem["kind"]]
        ? (entry.kind as EvidenceItem["kind"])
        : "other";
      evidence.push({
        kind,
        ref: entry.ref,
        detail: "detail" in entry && typeof entry.detail === "string" ? entry.detail : undefined,
      });
    }
    params.evidence = evidence;
  }
  return params;
}

function textResult(text: string, isError = false): AgentToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function registerCouncilAuditTool(pi: ExtensionAPI, runtime: RVEngine): void {
  const { Type } = pi.typebox;

  pi.registerTool({
    name: "council_audit",
    label: "Council Audit",
    description:
      "Audit completed work with an independent, different-model-family reviewer. Use after finishing consequential work: a plan, a diagnosis, a port, a recommendation. Returns a typed verdict (pass/concern/fail/split) with specific findings and corrections.",
    parameters: Type.Object({
      mode: Type.Enum(["review", "best", "fusion", "compare"], {
        description: "Council mode. Only 'review' is implemented (M1).",
      }),
      goal: Type.String({ description: "The user goal or task the work under review was meant to accomplish." }),
      proposal: Type.Optional(
        Type.String({ description: "The completed answer/action to audit. Required for review mode." }),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String(), { description: "Hard constraints the answer must satisfy." }),
      ),
      candidateCount: Type.Optional(
        Type.Number({ description: "Ensemble modes: how many candidates to generate (2-8, default from config).", minimum: 2, maximum: 8 }),
      ),
      evidence: Type.Optional(
        Type.Array(
          Type.Object({
            kind: Type.Optional(
              Type.Enum(["file", "quote", "url", "tool_output", "other"], { description: "Evidence type (default: other)." }),
            ),
            ref: Type.String({ description: "File path, quoted text, URL, or tool-output reference." }),
            detail: Type.Optional(Type.String({ description: "Why this evidence matters." })),
          }),
          { description: "Evidence the reviewer must weigh (cited sources, tool output, specs)." },
        ),
      ),
    }),
    execute: async (_toolCallId, rawParams, signal, _onUpdate, ctx) => {
      const params = parseParams(rawParams);
      if (typeof params === "string") return textResult(`council_audit: ${params}`, true);
      const enabledSeats = runtime.config.reviewers.filter((r) => r.enabled).length;
      if (enabledSeats === 0) {
        return textResult(`council_audit unavailable: no enabled reviewers in ${runtime.paths.configPath}.`, true);
      }
      const primaryFamily = ctx.model ? ctx.models.family(ctx.model) : undefined;
      if (params.mode === "review") {
        if (!params.proposal || params.proposal.trim().length === 0) {
          return textResult("council_audit review requires `proposal`: the completed answer/action to audit.", true);
        }
        const verdict = await runtime.runReview(
          ctx,
          {
            goal: params.goal,
            proposal: params.proposal,
            constraints: params.constraints,
            evidence: params.evidence,
            primaryFamily,
            activationReason: "tool_call",
          },
          signal,
        );
        return textResult(`${renderStatusLine(verdict)}\n\n${renderVerdict(verdict)}`, verdict.status === "fail");
      }
      if (params.mode !== "best" && params.mode !== "fusion" && params.mode !== "compare") {
        return textResult(`council_audit: unknown mode "${params.mode}" — use review, best, fusion, or compare.`, true);
      }
      if (enabledSeats < 2) {
        return textResult(`council_audit ${params.mode} needs at least 2 enabled reviewers; only ${enabledSeats} configured.`, true);
      }
      const verdict = await runtime.runEnsemble(
        ctx,
        {
          mode: params.mode,
          goal: params.goal,
          constraints: params.constraints,
          evidence: params.evidence,
          candidateCount: params.candidateCount,
          primaryFamily,
          activationReason: "tool_call",
        },
        signal,
      );
      return textResult(`${renderStatusLine(verdict)}\n\n${renderVerdict(verdict)}`, verdict.status === "fail");
    },
  });
}
