/**
 * Pre-execution Plan Controller for Resolve Vector OMP.
 *
 * Intercepts consequential tasks before any file edits or external side-effects occur.
 * Workflow:
 * 1. OMP researches and proposes a plan only.
 * 2. RV council reviews the plan.
 * 3. OMP rethinks its plan using RV findings (bounded by maxRethinkRounds).
 * 4. RV checks the revised plan.
 * 5. Accepted plan either waits for user approval (ask mode) or executes automatically (auto mode).
 * 6. Existing completion review verifies final execution afterwards.
 */
import type {
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { PlanMode, ResolveVectorConfig } from "./policy.js";
import type { CouncilVerdict, Finding } from "./receipts.js";
import { classifyShellCommand } from "./shell-classifier.js";
import type { RVEngine } from "./runtime.js";

export const RV_PLAN_PROMPT_TYPE = "rv-plan-prompt";
export const RV_PLAN_RETHINK_TYPE = "rv-plan-rethink";
export const RV_PLAN_STEERING_TYPE = "rv-plan-steering";
export const RV_PLAN_EXECUTE_TYPE = "rv-plan-execute";

export type PlanState =
  | "idle"
  | "planning"
  | "reviewingPlan"
  | "rethinking"
  | "reviewingRevision"
  | "accepted"
  | "awaitingUser"
  | "executing"
  | "cancelled";

export interface PlanControllerState {
  state: PlanState;
  generation: number;
  correlationId?: string;
  originalGoal?: string;
  originalPlan?: string;
  revisedPlan?: string;
  rethinkRound: number;
  planVerdict?: CouncilVerdict;
  revisionVerdict?: CouncilVerdict;
  workflowTurnIds: string[];
  awaitingDecision?: {
    reason: "ask_mode" | "split" | "critical" | "exhausted_rethinks" | "destructive" | "external";
    plan: string;
    verdict: CouncilVerdict;
  };
}

export interface PlanControllerDeps {
  notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
  sendPlanPrompt: (text: string, correlationId: string) => void;
  sendRethinkPrompt: (text: string, correlationId: string) => void;
  sendExecutePrompt: (text: string, correlationId: string) => void;
  leafEntryId: (ctx: ExtensionContext) => string | undefined;
  lastExchange: (ctx: ExtensionContext) => { goal?: string; proposal?: string };
  primaryFamily: (ctx: ExtensionContext) => string | undefined;
}

const CONSEQUENTIAL_RE =
  /\b(implement|build|create|add|fix|refactor|rewrite|migrate|install|configure|update|upgrade|delete|remove|publish|deploy|ship)\b/i;
const MULTI_FILE_RE = /\b(across|multiple files|architecture|refactor|redesign)\b/i;

function isConsequentialTask(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  const trimmed = text.trim();
  if (GREETING_RE.test(trimmed)) return false;
  if (trimmed.endsWith("?") && !CONSEQUENTIAL_RE.test(trimmed)) return false;
  return CONSEQUENTIAL_RE.test(trimmed) || MULTI_FILE_RE.test(trimmed);
}

const GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|great|nice|got it)\b/i;

export class PlanController {
  private generation = 0;
  private state: PlanControllerState = {
    state: "idle",
    generation: 0,
    rethinkRound: 0,
    workflowTurnIds: [],
  };
  private inFlight?: AbortController;

  constructor(
    private readonly runtime: RVEngine,
    private readonly deps: PlanControllerDeps,
  ) {}

  get currentState(): Readonly<PlanControllerState> {
    return this.state;
  }

  get mode(): PlanMode {
    return this.runtime.config.planning.mode;
  }

  setMode(mode: PlanMode): void {
    this.runtime.config.planning.mode = mode;
  }

  reset(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = undefined;
    this.state = {
      state: "idle",
      generation: this.generation,
      rethinkRound: 0,
      workflowTurnIds: [],
    };
  }

  /**
   * Returns true if turn is owned by the planning / rethink workflow.
   * ActivationController uses this to skip completion reviews on planning turns.
   */
  isWorkflowTurn(entryId?: string): boolean {
    if (!entryId) return false;
    return this.state.workflowTurnIds.includes(entryId);
  }

  /**
   * tool_call blocking hook: enforces the mutation barrier while planning/rethinking.
   */
  onToolCall(toolName: string, args: Record<string, unknown>): { block: boolean; reason?: string } {
    const activeStates: PlanState[] = [
      "planning",
      "reviewingPlan",
      "rethinking",
      "reviewingRevision",
      "awaitingUser",
    ];
    if (!activeStates.includes(this.state.state)) {
      return { block: false };
    }

    if (this.mode === "off") return { block: false };

    // Explicitly allow read-only tools
    if (["read", "grep", "glob", "file_structure", "list_dir", "view_file"].includes(toolName)) {
      return { block: false };
    }

    // Hard block edit/write
    if (["edit", "write", "replace_file_content", "multi_replace_file_content", "write_to_file"].includes(toolName)) {
      return {
        block: true,
        reason:
          "RV plan review is active. This turn may inspect and plan, but it cannot change files or external state. Finish the plan first.",
      };
    }

    // Shell classification
    if (toolName === "bash" || toolName === "run_command") {
      const command = String(args.command || args.CommandLine || "");
      const classified = classifyShellCommand(command);
      if (classified.readOnly) return { block: false };
      return {
        block: true,
        reason: `RV plan review is active. Shell command "${command.slice(0, 60)}" is classified as mutating (${classified.reason ?? "fail-closed"}). Finish and approve the plan first.`,
      };
    }

    // Fail closed on any other tool
    return {
      block: true,
      reason: `RV plan review is active. Tool "${toolName}" cannot be verified as read-only. Finish and approve the plan first.`,
    };
  }

  /**
   * before_agent_start hook: triggers deterministic activation before mutation.
   */
  onBeforeAgentStart(userText?: string): BeforeAgentStartEventResult | void {
    if (this.mode === "off") return;

    const gate = this.state.awaitingDecision;
    if (gate && this.state.state === "awaitingUser") {
      // Ordinary user text at gate acts as steering instructions
      return {
        message: {
          customType: RV_PLAN_STEERING_TYPE,
          content: [
            {
              type: "text",
              text: `[Resolve Vector — Plan Review Gate Context]\nOriginal Goal: ${this.state.originalGoal ?? ""}\nCurrent Plan: ${gate.plan}\nFindings: ${renderFindingsSummary(gate.verdict)}\n\nTreat the user's message as steering feedback. Revise the plan accordingly. Do not edit files yet.`,
            },
          ],
          display: false,
          details: { correlationId: this.state.correlationId },
        },
      };
    }

    if (this.state.state === "idle" && userText && isConsequentialTask(userText)) {
      this.state.state = "planning";
      this.state.originalGoal = userText;
      this.state.correlationId = `rv-plan-${this.generation.toString(36)}-${Date.now().toString(36)}`;
      this.deps.notify(
        { ui: { notify: () => {} } } as unknown as ExtensionContext,
        "RV · pre-execution plan review active — OMP authoring initial plan…",
        "info",
      );
      return {
        message: {
          customType: RV_PLAN_PROMPT_TYPE,
          content: [
            {
              type: "text",
              text: "Before changing files or external state, inspect what you need and produce a concise implementation plan. State the intended outcome, affected components, important risks, validation, and any decision that genuinely requires the user. Do not implement or edit files during this turn.",
            },
          ],
          display: false,
          details: { correlationId: this.state.correlationId },
        },
      };
    }
  }

  /**
   * agent_end hook: processes completed planning or rethink turns.
   */
  async onAgentEnd(messages: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    if (this.mode === "off" || this.state.state === "idle") return;

    const turn = analyzePlanTurn(messages);
    const leafId = this.deps.leafEntryId(ctx);
    if (leafId) this.state.workflowTurnIds.push(leafId);

    if (this.state.state === "planning") {
      if (!turn.proposal || turn.proposal.length < 15) return;
      this.state.originalPlan = turn.proposal;
      await this.reviewPlan(ctx, turn.proposal, false);
      return;
    }

    if (this.state.state === "rethinking") {
      if (!turn.proposal || turn.proposal.length < 15) return;
      this.state.revisedPlan = turn.proposal;
      await this.reviewPlan(ctx, turn.proposal, true);
      return;
    }
  }

  private async reviewPlan(ctx: ExtensionContext, plan: string, isRevision: boolean): Promise<void> {
    const gen = this.generation;
    this.state.state = isRevision ? "reviewingRevision" : "reviewingPlan";
    this.deps.notify(ctx, isRevision ? "RV · checking revised plan…" : "RV · checking OMP's plan…", "info");

    const controller = new AbortController();
    this.inFlight = controller;

    try {
      const goal = this.state.originalGoal ?? "Implementation task";
      const verdict = await this.runtime.runReview(
        ctx,
        {
          goal: `Planning phase for: ${goal}`,
          proposal: plan,
          primaryFamily: this.deps.primaryFamily(ctx),
          activationReason: isRevision ? "plan_revision" : "plan_initial",
          revisionRound: this.state.rethinkRound,
        },
        controller.signal,
      );

      if (gen !== this.generation) return;

      if (isRevision) this.state.revisionVerdict = verdict;
      else this.state.planVerdict = verdict;

      if (verdict.status === "pass") {
        this.state.state = "accepted";
        if (this.mode === "auto" && isSafeForAutoExecution(verdict)) {
          this.state.state = "executing";
          this.deps.notify(ctx, "RV · revised plan accepted — OMP starting work", "info");
          this.deps.sendExecutePrompt(
            `Plan accepted: ${plan}\n\nExecute the plan now. All tool calls are now unlocked.`,
            this.state.correlationId ?? "",
          );
        } else {
          this.state.state = "awaitingUser";
          this.state.awaitingDecision = {
            reason: this.mode === "ask" ? "ask_mode" : "external",
            plan,
            verdict,
          };
          this.presentDecisionPanel(ctx, "Resolve Vector reviewed OMP's plan.", plan, verdict);
        }
        return;
      }

      // Verdict is concern, fail, split, or review_unavailable
      if (verdict.status === "split" || verdict.status === "review_unavailable") {
        this.state.state = "awaitingUser";
        this.state.awaitingDecision = { reason: "split", plan, verdict };
        this.presentDecisionPanel(ctx, `Resolve Vector review resulted in ${verdict.status}.`, plan, verdict);
        return;
      }

      // Check rethink bounds
      const maxRethinks = this.runtime.config.planning.maxRethinkRounds;
      if (this.state.rethinkRound < maxRethinks) {
        this.state.rethinkRound += 1;
        this.state.state = "rethinking";
        const concernsCount = verdict.findings.length;
        this.deps.notify(
          ctx,
          `RV · ${concernsCount} concern${concernsCount === 1 ? "" : "s"} found — asking OMP to rethink the plan (round ${this.state.rethinkRound}/${maxRethinks})`,
          "warning",
        );
        this.deps.sendRethinkPrompt(buildRethinkMessage(verdict), this.state.correlationId ?? "");
      } else {
        this.state.state = "awaitingUser";
        this.state.awaitingDecision = { reason: "exhausted_rethinks", plan, verdict };
        this.presentDecisionPanel(
          ctx,
          `Resolve Vector and OMP reached max rethink rounds (${maxRethinks}). Your decision is needed.`,
          plan,
          verdict,
        );
      }
    } finally {
      if (gen === this.generation) this.inFlight = undefined;
    }
  }

  private presentDecisionPanel(
    ctx: ExtensionContext,
    header: string,
    plan: string,
    verdict: CouncilVerdict,
  ): void {
    const lines = [
      "┌────────────────────────────────────────────────────────┐",
      `│ ${header}`,
      "├────────────────────────────────────────────────────────┤",
      `│ Status: ${verdict.status.toUpperCase()} (${verdict.findings.length} findings)`,
      `│ Plan: ${plan.slice(0, 120).replace(/\n/g, " ")}…`,
      "│ No files have been changed yet.",
      "├────────────────────────────────────────────────────────┤",
      "│ What should OMP do?",
      "│   /rv proceed  — Approve and start work",
      "│   /rv plan     — Change or guide the plan",
      "│   /rv details  — Show complete review details",
      "│   /rv dismiss  — Cancel this work",
      "└────────────────────────────────────────────────────────┘",
    ];
    this.deps.notify(ctx, lines.join("\n"), "warning");
  }

  // Commands
  approveAndExecute(ctx: ExtensionContext): void {
    if (this.state.state !== "awaitingUser" || !this.state.awaitingDecision) {
      this.deps.notify(ctx, "RV · no pending plan review awaiting approval", "info");
      return;
    }
    const plan = this.state.awaitingDecision.plan;
    this.state.state = "executing";
    this.state.awaitingDecision = undefined;
    this.deps.notify(ctx, "RV · plan approved — starting execution…", "info");
    this.deps.sendExecutePrompt(
      `Plan approved: ${plan}\n\nExecute the plan now. All tool calls are unlocked.`,
      this.state.correlationId ?? "",
    );
  }

  dismissPlan(ctx: ExtensionContext): void {
    if (this.state.state === "idle") {
      this.deps.notify(ctx, "RV · no active plan workflow to cancel", "info");
      return;
    }
    this.state.state = "cancelled";
    this.deps.notify(ctx, "RV · plan review cancelled — no edits applied", "info");
    this.reset();
  }

  showDetails(ctx: ExtensionContext): void {
    const lines = [`RV Plan Review Status: ${this.state.state} (mode: ${this.mode})`];
    if (this.state.originalPlan) {
      lines.push("\n--- Proposed Plan ---\n" + this.state.originalPlan);
    }
    if (this.state.planVerdict) {
      lines.push(
        `\n--- RV Plan Verdict: ${this.state.planVerdict.status.toUpperCase()} ---\n` +
          renderFindingsSummary(this.state.planVerdict),
      );
    }
    if (this.state.revisedPlan) {
      lines.push("\n--- Revised Plan ---\n" + this.state.revisedPlan);
    }
    if (this.state.revisionVerdict) {
      lines.push(
        `\n--- RV Revision Verdict: ${this.state.revisionVerdict.status.toUpperCase()} ---\n` +
          renderFindingsSummary(this.state.revisionVerdict),
      );
    }
    this.deps.notify(ctx, lines.join("\n"), "info");
  }
}

function analyzePlanTurn(messages: readonly unknown[]): { proposal?: string } {
  let proposal: string | undefined;
  for (const message of messages) {
    if (typeof message === "object" && message !== null && "role" in message) {
      if (message.role === "assistant" && "content" in message) {
        const text = extractMessageText(message.content).trim();
        if (text.length > 0) proposal = text;
      }
    }
  }
  return { proposal };
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && "text" in b)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

function buildRethinkMessage(verdict: CouncilVerdict): string {
  const findingsText = verdict.findings
    .map((f, i) => `${i + 1}. [${f.severity}/${f.category}] ${f.claim} — ${f.concern}${f.suggestedCorrection ? ` (suggestion: ${f.suggestedCorrection})` : ""}`)
    .join("\n");
  return [
    `Resolve Vector found concerns with your proposed plan:`,
    findingsText,
    "",
    "Rethink the plan. Address every concern above or rebut it with concrete evidence.",
    "Return a complete revised plan, not a patch or commentary on the old plan.",
    "Do not implement or edit files during this turn.",
  ].join("\n");
}

function renderFindingsSummary(verdict: CouncilVerdict): string {
  if (verdict.findings.length === 0) return "No findings reported.";
  return verdict.findings
    .map((f) => `- [${f.severity}] ${f.claim}: ${f.concern}`)
    .join("\n");
}

function isSafeForAutoExecution(verdict: CouncilVerdict): boolean {
  if (verdict.status !== "pass") return false;
  const hasCritical = verdict.findings.some((f) => f.severity === "critical" || f.severity === "high");
  return !hasCritical;
}
