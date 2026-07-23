/**
 * Completion-boundary activation: agent_end trigger policy, provisional
 * labeling, the plan-gated remediation loop, and the guards that keep RV
 * from ever reviewing its own review machinery.
 *
 * M2.1 lifecycle hardening:
 * - GENERATIONS: every review captures a generation token. session_start /
 *   session_switch (reset) increments the generation and aborts the in-flight
 *   review. After every await, the review verifies its generation is still
 *   current before touching state, notifying, or correcting — a stale review
 *   from a dead session can never reach the active one.
 * - CORRECTION OWNERSHIP: each hidden correction carries a unique id. Only a
 *   turn containing that exact rv-correction id consumes the pending revision
 *   state; an unrelated user turn is always a normal turn.
 * - OVERLAP COALESCING: a substantive agent_end arriving mid-review is held
 *   in a one-item pending slot (newest wins) and reviewed once when the
 *   current review drains. A pending completion superseded by a corrective
 *   revision is dropped WITH a notification, never silently.
 *
 * Plan gate (release blocker): on concern/fail RV no longer launches an
 * autonomous correction. It renders the verdict and findings visibly, asks
 * the primary model for ONE plan-only remediation turn (no edits, no
 * mutating tools), displays that plan as normal output, and parks in
 * `awaitingUser`. Only an explicit user action — /rv proceed, /rv revise,
 * /rv dismiss, or ordinary steering text — produces the next turn. A
 * user-authorized revision is reviewed exactly once; if it still fails, RV
 * produces a fresh plan and pauses again (bounded by maxRevisionRounds).
 */
import type { BeforeAgentStartEventResult, ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { ActivationMode, ResolveVectorConfig } from "./policy.js";
import type { CouncilVerdict, Finding } from "./receipts.js";
import { renderSplitDetail, renderStatusLine, renderUnavailableDetail, renderVerdict } from "./render.js";
import type { RVEngine } from "./runtime.js";

/** Marker on the hidden corrective message; also how we recognize our own turns. */
export const RV_CORRECTION_TYPE = "rv-correction";
/** Marker on the hidden plan-request message (plan-only turn, no mutations). */
export const RV_PLAN_TYPE = "rv-plan";
/** Marker on the hidden steering context attached to ordinary user turns at the gate. */
export const RV_STEERING_TYPE = "rv-steering";

export interface ReviewState {
  reviewing: boolean;
  lastReviewedEntryId?: string;
  revisionRound: number;
  reviewTurnIds: string[];
  /** Id of the correction whose turn we expect; only that turn consumes it. */
  pendingCorrectionId?: string;
  /** Newest completion waiting for the in-flight review; one slot, newest wins. */
  pendingTurn?: { reason: "agent_end" | "revision" };
  /** Plan turn in flight (concern/fail); its completion opens the user gate. */
  pendingPlan?: { planId: string; verdict: CouncilVerdict; correctionId: string };
  /** Review paused for a user decision after a displayed plan. */
  awaitingUser?: { verdict: CouncilVerdict; correctionId: string; round: number; plan?: string };
}

export interface TurnAnalysis {
  substantive: boolean;
  /** Last assistant text of the turn (the proposal under review). */
  proposal?: string;
  /** Last user text of the turn (for explicit verify requests). */
  userText?: string;
  /** A mutating tool ran this turn (edit/write/bash). */
  filesChanged: boolean;
  /** A read-only research tool ran (read/grep/glob) → claims may rest on inspected sources. */
  researchToolsUsed: boolean;
  /** A council_audit ensemble ran this turn → output needs final verification. */
  ensembleOutput: boolean;
  /** Turn contains an rv-correction/rv-plan/rv-steering marker → RV triggered it. */
  isReviewTurn: boolean;
  /** Unique id of the correction this turn answers, if marked. */
  correctionId?: string;
  /** Unique id of the plan request this turn answers, if marked. */
  planId?: string;
}

export interface ActivationDeps {
  notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
  /** Hidden corrective injection: deliverAs nextTurn + triggerTurn, tagged with the id. */
  sendCorrection: (text: string, correctionId: string) => void;
  /** Hidden plan-request injection: deliverAs nextTurn + triggerTurn, tagged with the plan id. */
  sendPlan: (text: string, planId: string, correctionId: string) => void;
  leafEntryId: (ctx: ExtensionContext) => string | undefined;
  lastExchange: (ctx: ExtensionContext) => { goal?: string; proposal?: string };
  primaryFamily: (ctx: ExtensionContext) => string | undefined;
  rng?: () => number;
}

const MIN_SUBSTANTIVE_CHARS = 40;
const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, bash: true };
const RESEARCH_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

// Deterministic consequence signals (auto mode). Cheap regexes on the turn's
// own text — never model self-confidence.
const COMPLETION_RE = /\b(done|complete[ds]?|finished|implemented|fixed|ready to ship|all set)\b/i;
const DIAGNOSIS_RE = /\b(root cause|caused by|the (bug|issue|problem|failure|culprit) (is|was|lies)|the fix (is|was) to)\b/i;
const RECOMMEND_RE = /\b(i recommend|my recommendation|you should|the best (option|approach|choice)|decision:|i'd go with|i suggest)\b/i;
const VERIFY_RE = /\b(verify|audit|double[- ]?check|sanity[- ]?check|check (this|my|the|your)|review (this|my|the|your))\b/i;
const GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|great|nice|got it|lol)\b/i;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("");
    if (text.trim().length > 0) return text;
    // Transport quirk (vllm-mlx): some servers return the entire reply as
    // reasoning_content with empty content. When there is no text at all,
    // the thinking payload IS the answer the user saw — use it.
    return content
      .filter(
        (block): block is { type: "thinking"; thinking: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "thinking" &&
          "thinking" in block &&
          typeof block.thinking === "string",
      )
      .map((block) => block.thinking)
      .join("");
  }
  return "";
}

/** Last user goal + last assistant answer on the current branch (shared with /rv review). */
export function lastExchangeFromEntries(entries: readonly SessionEntry[]): { goal?: string; proposal?: string } {
  let goal: string | undefined;
  let proposal: string | undefined;
  for (let i = entries.length - 1; i >= 0 && (goal === undefined || proposal === undefined); i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!("role" in message) || !("content" in message)) continue;
    const text = messageText(message.content).trim();
    if (text.length === 0) continue;
    if (message.role === "assistant" && proposal === undefined) proposal = text;
    if (message.role === "user" && proposal !== undefined && goal === undefined) goal = text;
  }
  return { goal, proposal };
}

/**
 * Classify a completed agent turn. `messages` is the AgentEndEvent payload:
 * turn-local, so an rv-correction marker here means RV triggered the turn.
 */
export function analyzeTurn(messages: readonly unknown[]): TurnAnalysis {
  let proposal: string | undefined;
  let userText: string | undefined;
  let filesChanged = false;
  let researchToolsUsed = false;
  let ensembleOutput = false;
  let isReviewTurn = false;
  let correctionId: string | undefined;
  let planId: string | undefined;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !("role" in message)) continue;
    if (message.role === "custom" && "customType" in message) {
      if (message.customType === RV_CORRECTION_TYPE || message.customType === RV_STEERING_TYPE) {
        isReviewTurn = true;
        if ("details" in message && typeof message.details === "object" && message.details !== null && "correctionId" in message.details) {
          const candidate = message.details.correctionId;
          if (typeof candidate === "string") correctionId = candidate;
        }
        continue;
      }
      if (message.customType === RV_PLAN_TYPE) {
        isReviewTurn = true;
        if ("details" in message && typeof message.details === "object" && message.details !== null && "planId" in message.details) {
          const candidate = message.details.planId;
          if (typeof candidate === "string") planId = candidate;
        }
        continue;
      }
    }
    if (message.role === "assistant" && "content" in message) {
      const text = messageText(message.content).trim();
      if (text.length > 0) proposal = text;
    }
    if (message.role === "user" && "content" in message) {
      const text = messageText(message.content).trim();
      if (text.length > 0) userText = text;
    }
    if (message.role === "toolResult") {
      if ("toolName" in message && typeof message.toolName === "string") {
        if (MUTATING_TOOLS[message.toolName]) filesChanged = true;
        if (RESEARCH_TOOLS[message.toolName]) researchToolsUsed = true;
        if (message.toolName === "council_audit") ensembleOutput = true;
      }
      // council_audit is also reached through the xd:// write-device wrapper;
      // its details carry the real tool under xdev.
      if (
        "details" in message &&
        typeof message.details === "object" &&
        message.details !== null &&
        "xdev" in message.details &&
        typeof message.details.xdev === "object" &&
        message.details.xdev !== null &&
        "tool" in message.details.xdev &&
        message.details.xdev.tool === "council_audit"
      ) {
        ensembleOutput = true;
      }
    }
  }
  const substantive = (proposal !== undefined && proposal.length >= MIN_SUBSTANTIVE_CHARS) || filesChanged;
  return { substantive, proposal, userText, filesChanged, researchToolsUsed, ensembleOutput, isReviewTurn, correctionId, planId };
}

export interface ActivationDecision {
  activate: boolean;
  /** Deterministic reason tag recorded on the receipt (heuristic tuning data). */
  reason?: string;
}

/** Trivial turns the auto policy must NOT review. */
function isAvoidableTurn(turn: TurnAnalysis): boolean {
  const proposal = turn.proposal ?? "";
  // Greetings / acknowledgments.
  if (proposal.length > 0 && proposal.length < 120 && GREETING_RE.test(proposal)) return true;
  // Clarification questions back to the user (no work completed).
  if (!turn.filesChanged && proposal.length > 0 && proposal.length < 400 && proposal.trimEnd().endsWith("?")) return true;
  return false;
}

/**
 * Mode policy. auto = deterministic consequence signals (files changed,
 * completion claimed, diagnosis, recommendation, source report, explicit
 * verify request, ensemble output) — never answer length or self-confidence.
 */
export function shouldActivate(
  config: ResolveVectorConfig,
  turn: TurnAnalysis,
  rng: () => number,
): ActivationDecision {
  if (!turn.substantive || turn.isReviewTurn) return { activate: false };
  switch (config.mode as ActivationMode) {
    case "off":
    case "manual":
      return { activate: false };
    case "always":
      return { activate: true, reason: "always" };
    case "sample": {
      const roll = rng();
      return { activate: roll < config.sampleRate, reason: `sample:${roll.toFixed(3)}` };
    }
    case "auto": {
      if (isAvoidableTurn(turn)) return { activate: false };
      if (turn.filesChanged) return { activate: true, reason: "files_changed" };
      if (turn.ensembleOutput) return { activate: true, reason: "ensemble_verification" };
      if (turn.userText && VERIFY_RE.test(turn.userText)) return { activate: true, reason: "user_requested" };
      const proposal = turn.proposal ?? "";
      if (COMPLETION_RE.test(proposal)) return { activate: true, reason: "completion_claim" };
      if (DIAGNOSIS_RE.test(proposal)) return { activate: true, reason: "diagnosis" };
      if (RECOMMEND_RE.test(proposal)) return { activate: true, reason: "recommendation" };
      if (turn.researchToolsUsed) return { activate: true, reason: "source_report" };
      return { activate: false };
    }
  }
}

function formatFindingsForCorrection(findings: readonly Finding[]): string {
  return findings
    .slice(0, 5)
    .map((f, i) => {
      const parts = [`${i + 1}. [${f.severity}/${f.category}] ${f.claim} — ${f.concern}`];
      if (f.suggestedCorrection) parts.push(`   correction: ${f.suggestedCorrection}`);
      return parts.join("\n");
    })
    .join("\n");
}

/** Plan-gate gate: the ONLY autonomous turn after concern/fail asks for a plan. */
export function buildPlanMessage(verdict: CouncilVerdict): string {
  return [
    `Resolve Vector review of your previous answer returned ${verdict.status.toUpperCase()}.`,
    verdict.summary,
    "",
    "Findings to address:",
    formatFindingsForCorrection(verdict.findings),
    "",
    "Produce a remediation PLAN ONLY for this turn. Hard rules:",
    "- Do NOT edit files, write files, or run mutating tools (edit/write/bash are forbidden this turn).",
    "- Do NOT implement anything. No code changes, no commands with side effects.",
    "- Output a concise numbered plan: what to change, where, and why — addressing every finding above, or rebutting one with concrete evidence.",
    "The user reviews your plan next. Execution happens only after their explicit go-ahead.",
  ].join("\n");
}

/** User-authorized execution turn (/rv proceed, /rv revise, or steering text). */
export function buildExecutionMessage(
  gate: { verdict: CouncilVerdict; plan?: string },
  instructions?: string,
): string {
  const lines = [
    `Resolve Vector review of your previous answer returned ${gate.verdict.status.toUpperCase()}.`,
    gate.verdict.summary,
    "",
    "Findings to resolve:",
    formatFindingsForCorrection(gate.verdict.findings),
  ];
  if (gate.plan) {
    lines.push("", "The remediation plan you proposed:", gate.plan);
  }
  if (instructions && instructions.trim().length > 0) {
    lines.push("", `User steering instructions: ${instructions.trim()}`);
  }
  lines.push(
    "",
    "The user has authorized execution. Implement the plan now — resolve every finding or rebut one with concrete evidence. Do not repeat a flagged claim unchanged.",
  );
  return lines.join("\n");
}

/** Hidden context attached to an ordinary user turn while the gate is open. */
export function buildSteeringContext(gate: { verdict: CouncilVerdict; plan?: string }): string {
  const lines = [
    "[Resolve Vector — review gate context; not part of the user's message]",
    `The previous answer was reviewed: ${gate.verdict.status.toUpperCase()} — ${gate.verdict.summary}`,
    "Findings:",
    formatFindingsForCorrection(gate.verdict.findings),
  ];
  if (gate.plan) {
    lines.push("", "Pending remediation plan:", gate.plan);
  }
  lines.push(
    "",
    "Treat the user's message as steering for how to proceed with these findings and this plan. If the user is directing the fix, implement it accordingly; resolve every finding or rebut one with concrete evidence.",
  );
  return lines.join("\n");
}

/** Short roster labels for the `RV · review started` line (Qwen + Kimi style). */
export function shortReviewerLabel(family: string, id: string): string {
  const head = family.split("-")[0]?.trim();
  if (head && head.length > 0) return head[0].toUpperCase() + head.slice(1);
  return id;
}

export class ActivationController {
  private readonly state: ReviewState = {
    reviewing: false,
    revisionRound: 0,
    reviewTurnIds: [],
  };
  /** Incremented on every session reset; captured by each review. */
  private generation = 0;
  private correctionCounter = 0;
  /** Aborts the in-flight review on session reset. */
  private inFlight?: AbortController;

  constructor(
    private readonly runtime: RVEngine,
    private readonly deps: ActivationDeps,
  ) {}

  /** Test/introspection seam. */
  get reviewState(): Readonly<ReviewState> {
    return this.state;
  }

  /** agent_end entry point. Never throws; failures degrade to a notify. */
  async onAgentEnd(messages: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    const gen = this.generation;
    try {
      await this.handle(messages, ctx);
    } catch (error) {
      if (gen !== this.generation) return; // stale session: silent
      this.state.reviewing = false;
      this.deps.notify(ctx, `RV · review failed: ${(error as Error).message}`, "warning");
    }
  }

  /** New session boundary: invalidate everything from the previous session. */
  reset(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = undefined;
    this.state.reviewing = false;
    this.state.lastReviewedEntryId = undefined;
    this.state.revisionRound = 0;
    this.state.reviewTurnIds = [];
    this.state.pendingCorrectionId = undefined;
    this.state.pendingTurn = undefined;
    this.state.pendingPlan = undefined;
    this.state.awaitingUser = undefined;
  }

  private async handle(messages: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    const config = this.runtime.config;
    const turn = analyzeTurn(messages);

    // Plan turn completed → open the user gate. Never reviewed, never
    // auto-activated: the plan is RV's own request, displayed as normal output.
    if (turn.planId !== undefined && turn.planId === this.state.pendingPlan?.planId) {
      const pending = this.state.pendingPlan;
      this.state.pendingPlan = undefined;
      this.state.awaitingUser = {
        verdict: pending.verdict,
        correctionId: pending.correctionId,
        round: this.state.revisionRound,
        plan: turn.proposal,
      };
      this.state.pendingCorrectionId = pending.correctionId;
      this.deps.notify(
        ctx,
        "RV · awaiting your decision — /rv proceed · /rv revise <instructions> · /rv dismiss · /rv details",
        "warning",
      );
      return;
    }

    // Only the turn carrying OUR correction id is a revision. An unrelated
    // user turn while a correction is pending stays a normal turn.
    const isCorrelatedRevision =
      turn.correctionId !== undefined && turn.correctionId === this.state.pendingCorrectionId;
    if (isCorrelatedRevision) {
      this.state.pendingCorrectionId = undefined;
      this.state.awaitingUser = undefined;
      if (!turn.substantive) {
        // Steering consumed the gate but produced nothing reviewable.
        this.deps.notify(ctx, "RV · review gate closed — nothing substantive to review", "info");
        return;
      }
      if (this.state.reviewing) {
        this.state.pendingTurn = { reason: "revision" };
        return;
      }
      await this.reviewCurrentAnswer(ctx, "revision");
      return;
    }

    // While the gate is open, unrelated agent_end events (background tasks,
    // stray completions) must not auto-review or disturb the gate.
    if (this.state.awaitingUser !== undefined) return;

    const decision = shouldActivate(config, turn, this.deps.rng ?? Math.random);
    if (!decision.activate) return;
    if (this.state.reviewing) {
      // Coalesce: keep only the newest completion for after the current review.
      this.state.pendingTurn = { reason: "agent_end" };
      return;
    }

    const leaf = this.deps.leafEntryId(ctx);
    if (leaf !== undefined && leaf === this.state.lastReviewedEntryId) return; // never twice

    await this.reviewCurrentAnswer(ctx, "agent_end", leaf, decision.reason);
  }

  private async reviewCurrentAnswer(
    ctx: ExtensionContext,
    reason: "agent_end" | "revision",
    leaf?: string,
    activationDetail?: string,
  ): Promise<void> {
    const gen = this.generation;
    let current: { reason: "agent_end" | "revision"; leaf?: string; detail?: string } = { reason, leaf, detail: activationDetail };
    this.state.reviewing = true;
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      for (;;) {
        const { goal, proposal } = this.deps.lastExchange(ctx);
        if (!proposal || proposal.trim().length === 0) return;
        const roster = this.runtime.config.reviewers
          .filter((r) => r.enabled)
          .map((r) => shortReviewerLabel(r.family, r.id));
        this.deps.notify(
          ctx,
          roster.length > 0
            ? `RV · review started — ${roster.join(" + ")}`
            : "RV · review started (no reviewers configured)",
          "info",
        );
        const verdict = await this.runtime.runReview(
          ctx,
          {
            goal: goal ?? "(goal unavailable — review the answer on its own merits)",
            proposal,
            primaryFamily: this.deps.primaryFamily(ctx),
            activationReason: current.reason,
            activationDetail: current.detail ?? (current.reason === "revision" ? "revision" : undefined),
            revisionRound: this.state.revisionRound,
            onProgress: (event) => {
              if (gen !== this.generation) return; // stale session: silent
              if (event.type === "reviewer_unavailable") {
                this.deps.notify(
                  ctx,
                  event.remaining.length > 0
                    ? `RV · ${event.reviewerId} unavailable (${event.detail}) — continuing with ${event.remaining.join(" and ")}`
                    : `RV · ${event.reviewerId} unavailable (${event.detail})`,
                  "warning",
                );
              }
            },
          },
          controller.signal,
        );
        // Stale-session guard: after every await, bail without side effects.
        if (gen !== this.generation) return;
        const entryId = current.leaf ?? this.deps.leafEntryId(ctx);
        if (entryId !== undefined) {
          this.state.lastReviewedEntryId = entryId;
          if (current.reason === "revision") this.state.reviewTurnIds.push(entryId);
        }
        this.actOnVerdict(ctx, verdict);

        // Drain the coalesced pending completion — unless a plan-gate turn
        // now owns the next turn (the pending answer is superseded).
        const pending = this.state.pendingTurn;
        this.state.pendingTurn = undefined;
        if (pending === undefined) return;
        if (this.state.pendingCorrectionId !== undefined || this.state.pendingPlan !== undefined) {
          this.deps.notify(ctx, "RV · queued completion superseded by remediation plan gate", "info");
          return;
        }
        current = pending;
      }
    } finally {
      if (gen === this.generation) {
        this.state.reviewing = false;
        this.inFlight = undefined;
      }
    }
  }

  private actOnVerdict(ctx: ExtensionContext, verdict: CouncilVerdict): void {
    const max = this.runtime.config.maxRevisionRounds;
    switch (verdict.status) {
      case "pass":
        this.state.revisionRound = 0;
        this.deps.notify(ctx, renderStatusLine(verdict), "info");
        return;
      case "review_unavailable":
        this.state.revisionRound = 0;
        this.deps.notify(ctx, renderStatusLine(verdict), "warning");
        this.deps.notify(ctx, renderUnavailableDetail(verdict), "warning");
        return;
      case "split": {
        // Terminal escalation, never a correction request: RV does not know
        // which side is right, so the loop STOPS and the human decides. No
        // hidden correction, no revision round, no fused middle ground.
        this.state.revisionRound = 0;
        this.state.pendingCorrectionId = undefined;
        this.state.pendingTurn = undefined;
        this.deps.notify(ctx, "RV · split verdict — user decision needed", "warning");
        this.deps.notify(ctx, renderSplitDetail(verdict), "info");
        return;
      }
      default: {
        if (this.state.revisionRound < max) {
          // Plan gate: verdict + findings visible FIRST, then ONE plan-only
          // turn, then a hard stop until the user decides. No execution turn.
          this.state.revisionRound += 1;
          this.correctionCounter += 1;
          const correctionId = `rv-cor-${this.generation.toString(36)}-${this.correctionCounter.toString(36)}`;
          const planId = `${correctionId}-plan`;
          this.state.pendingPlan = { planId, verdict, correctionId };
          this.deps.notify(
            ctx,
            `${renderStatusLine(verdict)} — remediation plan requested (round ${this.state.revisionRound}/${max})`,
            "warning",
          );
          this.deps.notify(ctx, renderVerdict(verdict), "info");
          this.deps.sendPlan(buildPlanMessage(verdict), planId, correctionId);
        } else {
          const rounds = this.state.revisionRound;
          this.state.revisionRound = 0;
          this.deps.notify(
            ctx,
            `RV · unresolved after ${rounds} revision round${rounds === 1 ? "" : "s"} — ${verdict.status}; your decision needed. Review stopped.`,
            "warning",
          );
        }
      }
    }
  }

  // ── User gate (awaitingUser) facade ──────────────────────────────────────

  /** before_agent_start hook: ordinary user text at the gate gets the
   * findings + pending plan attached and consumes the gate as steering. */
  onBeforeAgentStart(): BeforeAgentStartEventResult | void {
    const gate = this.state.awaitingUser;
    if (!gate) return;
    return {
      message: {
        customType: RV_STEERING_TYPE,
        content: [{ type: "text", text: buildSteeringContext(gate) }],
        display: false,
        details: { correctionId: gate.correctionId },
      },
    };
  }

  /** /rv proceed: execute the pending plan (user-authorized). */
  proceedWithPlan(ctx: ExtensionContext, instructions?: string): void {
    const gate = this.state.awaitingUser;
    if (!gate) {
      this.deps.notify(ctx, "RV · no pending review decision — nothing to proceed with", "info");
      return;
    }
    this.state.awaitingUser = undefined;
    this.state.pendingCorrectionId = gate.correctionId;
    this.deps.sendCorrection(buildExecutionMessage(gate, instructions), gate.correctionId);
    this.deps.notify(
      ctx,
      instructions && instructions.trim().length > 0
        ? "RV · executing the remediation plan with your instructions…"
        : "RV · executing the remediation plan…",
      "info",
    );
  }

  /** /rv dismiss: close the gate without any turn. */
  dismissGate(ctx: ExtensionContext): void {
    if (!this.state.awaitingUser) {
      this.deps.notify(ctx, "RV · no pending review decision to dismiss", "info");
      return;
    }
    this.state.awaitingUser = undefined;
    this.state.pendingCorrectionId = undefined;
    this.state.revisionRound = 0;
    this.deps.notify(ctx, "RV · review dismissed — findings noted, no changes applied", "info");
  }

  /** /rv details: reprint the verdict and the pending plan. */
  gateDetails(ctx: ExtensionContext): void {
    const gate = this.state.awaitingUser;
    if (!gate) {
      this.deps.notify(ctx, "RV · no pending review decision — /rv details is only live at the plan gate", "info");
      return;
    }
    this.deps.notify(ctx, renderVerdict(gate.verdict), "info");
    if (gate.plan) {
      this.deps.notify(ctx, `Remediation plan (proposed, awaiting your decision):\n${gate.plan}`, "info");
    }
  }
}
