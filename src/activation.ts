/**
 * Completion-boundary activation: agent_end trigger policy, provisional
 * labeling, the corrective nextTurn loop, and the recursion guards that keep
 * RV from ever reviewing its own review machinery.
 *
 * Flow (brief §5): primary agent finishes → substantive non-RV turn activates
 * per mode → answer marked provisional → council runs headlessly → pass renders
 * verified; concern/fail injects a hidden nextTurn correction → the revision
 * turn is itself reviewed, bounded by maxRevisionRounds → unresolved means the
 * loop STOPS and the user decides.
 *
 * Loop safety invariants:
 * - RV never reviews a turn it triggered (rv-correction marker or pending flag).
 * - The same leaf entry is never reviewed twice.
 * - At most maxRevisionRounds corrections per answer; then the loop stops.
 * - One review in flight at a time (`reviewing` guard).
 */
import type { ExtensionContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { ActivationMode, ResolveVectorConfig } from "./policy.js";
import type { CouncilVerdict, Finding } from "./receipts.js";
import { renderStatusLine } from "./render.js";
import type { RVEngine } from "./runtime.js";

/** Marker on the hidden corrective message; also how we recognize our own turns. */
export const RV_CORRECTION_TYPE = "rv-correction";

export interface ReviewState {
  reviewing: boolean;
  lastReviewedEntryId?: string;
  revisionRound: number;
  reviewTurnIds: string[];
  /** Set when a corrective nextTurn is in flight; the next agent_end is ours. */
  expectingRevision: boolean;
}

export interface TurnAnalysis {
  substantive: boolean;
  /** Last assistant text of the turn (the proposal under review). */
  proposal?: string;
  /** A mutating tool ran this turn (edit/write/bash). */
  filesChanged: boolean;
  /** Turn contains an rv-correction marker → RV triggered it. */
  isReviewTurn: boolean;
}

export interface ActivationDeps {
  notify: (ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error") => void;
  /** Hidden corrective injection: deliverAs nextTurn + triggerTurn. */
  sendCorrection: (text: string) => void;
  leafEntryId: (ctx: ExtensionContext) => string | undefined;
  lastExchange: (ctx: ExtensionContext) => { goal?: string; proposal?: string };
  primaryFamily: (ctx: ExtensionContext) => string | undefined;
  rng?: () => number;
}

const MIN_SUBSTANTIVE_CHARS = 40;
const AUTO_LONG_ANSWER_CHARS = 500;
const MUTATING_TOOLS: Record<string, true> = { edit: true, write: true, bash: true };

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

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
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
  }
  return "";
}

/**
 * Classify a completed agent turn. `messages` is the AgentEndEvent payload:
 * turn-local, so an rv-correction marker here means RV triggered the turn.
 */
export function analyzeTurn(messages: readonly unknown[]): TurnAnalysis {
  let proposal: string | undefined;
  let filesChanged = false;
  let isReviewTurn = false;
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !("role" in message)) continue;
    if (message.role === "custom" && "customType" in message && message.customType === RV_CORRECTION_TYPE) {
      isReviewTurn = true;
      continue;
    }
    if (message.role === "assistant" && "content" in message) {
      const text = messageText(message.content).trim();
      if (text.length > 0) proposal = text;
    }
    if (message.role === "toolResult" && "toolName" in message && typeof message.toolName === "string") {
      if (MUTATING_TOOLS[message.toolName]) filesChanged = true;
    }
  }
  const substantive = (proposal !== undefined && proposal.length >= MIN_SUBSTANTIVE_CHARS) || filesChanged;
  return { substantive, proposal, filesChanged, isReviewTurn };
}

/** Mode policy. auto = initial deterministic heuristic per brief §5 (files changed or a long consequential answer). */
export function shouldActivate(
  config: ResolveVectorConfig,
  turn: TurnAnalysis,
  rng: () => number,
): boolean {
  if (!turn.substantive || turn.isReviewTurn) return false;
  switch (config.mode as ActivationMode) {
    case "off":
    case "manual":
      return false;
    case "always":
      return true;
    case "sample":
      return rng() < config.sampleRate;
    case "auto":
      return turn.filesChanged || (turn.proposal !== undefined && turn.proposal.length >= AUTO_LONG_ANSWER_CHARS);
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

export function buildCorrectionMessage(verdict: CouncilVerdict): string {
  return [
    `Resolve Vector review of your previous answer returned ${verdict.status.toUpperCase()}.`,
    verdict.summary,
    "",
    "Findings to address:",
    formatFindingsForCorrection(verdict.findings),
    "",
    "Revise your answer to resolve every finding above, or explicitly rebut one with concrete evidence. Do not repeat a flagged claim unchanged.",
  ].join("\n");
}

export class ActivationController {
  private readonly state: ReviewState = {
    reviewing: false,
    revisionRound: 0,
    reviewTurnIds: [],
    expectingRevision: false,
  };

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
    try {
      await this.handle(messages, ctx);
    } catch (error) {
      this.state.reviewing = false;
      this.deps.notify(ctx, `RV · review failed: ${(error as Error).message}`, "warning");
    }
  }

  private async handle(messages: readonly unknown[], ctx: ExtensionContext): Promise<void> {
    const config = this.runtime.config;
    const turn = analyzeTurn(messages);

    // Revision turns (triggered by our correction) skip activation policy but
    // are themselves reviewed — bounded by maxRevisionRounds.
    const isRevisionTurn = this.state.expectingRevision || turn.isReviewTurn;
    this.state.expectingRevision = false;
    if (isRevisionTurn) {
      if (this.state.reviewing) return;
      await this.reviewCurrentAnswer(ctx, "revision");
      return;
    }

    if (!shouldActivate(config, turn, this.deps.rng ?? Math.random)) return;
    if (this.state.reviewing) return; // one review in flight

    const leaf = this.deps.leafEntryId(ctx);
    if (leaf !== undefined && leaf === this.state.lastReviewedEntryId) return; // never twice

    await this.reviewCurrentAnswer(ctx, "agent_end", leaf);
  }

  private async reviewCurrentAnswer(ctx: ExtensionContext, reason: "agent_end" | "revision", leaf?: string): Promise<void> {
    const { goal, proposal } = this.deps.lastExchange(ctx);
    if (!proposal || proposal.trim().length === 0) return;

    this.state.reviewing = true;
    this.deps.notify(ctx, `RV · provisional — reviewing previous answer…`, "info");
    try {
      const verdict = await this.runtime.runReview(
        ctx,
        {
          goal: goal ?? "(goal unavailable — review the answer on its own merits)",
          proposal,
          primaryFamily: this.deps.primaryFamily(ctx),
          activationReason: reason,
          revisionRound: this.state.revisionRound,
        },
      );
      const entryId = leaf ?? this.deps.leafEntryId(ctx);
      if (entryId !== undefined) {
        this.state.lastReviewedEntryId = entryId;
        if (reason === "revision") this.state.reviewTurnIds.push(entryId);
      }
      this.actOnVerdict(ctx, verdict);
    } finally {
      this.state.reviewing = false;
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
        return;
      default: {
        if (this.state.revisionRound < max) {
          this.state.revisionRound += 1;
          this.state.expectingRevision = true;
          this.deps.sendCorrection(buildCorrectionMessage(verdict));
          this.deps.notify(
            ctx,
            `${renderStatusLine(verdict)} — revision requested (round ${this.state.revisionRound}/${max})`,
            "warning",
          );
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

  /** Fresh session state on session_start/switch. */
  reset(): void {
    this.state.reviewing = false;
    this.state.lastReviewedEntryId = undefined;
    this.state.revisionRound = 0;
    this.state.reviewTurnIds = [];
    this.state.expectingRevision = false;
  }
}
