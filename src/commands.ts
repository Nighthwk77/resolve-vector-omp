/**
 * `/rv` slash-command routing. Every subcommand funnels into RVRuntime —
 * manual review and (later) automatic activation share the engine and receipts.
 */
import type { ExtensionCommandContext, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ActivationMode } from "./policy.js";
import { renderStatusLine, renderVerdict } from "./render.js";
import type { RVEngine } from "./runtime.js";

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

/** Last user goal + last assistant answer on the current branch. */
export function lastExchange(ctx: ExtensionCommandContext): { goal?: string; proposal?: string } {
  const entries = ctx.sessionManager.getBranch();
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

async function cmdStatus(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
  const { config } = runtime;
  const lines: string[] = [
    `Resolve Vector — mode: ${config.mode} · council: ${config.defaultCouncilMode}`,
    `budgets: ${config.maxExternalAuditsPerHour}/h, ${config.maxExternalAuditsPerDay}/d external · concurrency ${config.maxConcurrentReviewers}`,
  ];
  if (runtime.configCreated) lines.push(`config: no file at ${runtime.paths.configPath} — defaults in effect`);
  for (const error of runtime.configErrors) lines.push(`config error: ${error}`);
  if (config.reviewers.length === 0) {
    lines.push("reviewers: none configured — add seats to resolve-vector.json");
  } else {
    lines.push("reviewers:");
    for (const reviewer of config.reviewers) {
      const flags = [reviewer.local ? "local" : "remote", reviewer.enabled ? "enabled" : "disabled", reviewer.trigger ?? "always"];
      lines.push(`  ${reviewer.order}. ${reviewer.id} — ${reviewer.provider}/${reviewer.model} (${reviewer.family}, ${reviewer.role}) [${flags.join(", ")}]`);
    }
  }
  const recent = await runtime.recentReceipts(3);
  if (recent.length > 0) {
    lines.push("recent verdicts:");
    for (const receipt of recent) {
      lines.push(`  ${receipt.verdict.createdAt} — ${receipt.verdict.status} (${receipt.activationReason}) ${receipt.verdict.id}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdReview(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
  if (runtime.config.reviewers.filter((r) => r.enabled).length === 0) {
    ctx.ui.notify(`RV · no enabled reviewers. Configure resolve-vector.json at ${runtime.paths.configPath}`, "warning");
    return;
  }
  const { goal, proposal } = lastExchange(ctx);
  if (!proposal) {
    ctx.ui.notify("RV · nothing to review — no assistant answer in this session yet", "warning");
    return;
  }
  ctx.ui.notify("RV · reviewing…", "info");
  const verdict = await runtime.runReview(ctx, {
    goal: goal ?? "(goal unavailable — review the answer on its own merits)",
    proposal,
    primaryFamily: ctx.model ? ctx.models.family(ctx.model) : undefined,
    activationReason: "manual_command",
  });
  ctx.ui.notify(renderStatusLine(verdict), verdict.status === "pass" ? "info" : "warning");
  ctx.ui.notify(renderVerdict(verdict), "info");
}

const ON_MODES: Record<string, ActivationMode> = { auto: "auto", always: "always", sample: "sample" };

async function dispatch(runtime: RVEngine, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  switch (sub) {
    case "status":
      return cmdStatus(runtime, ctx);
    case "review":
      return cmdReview(runtime, ctx);
    case "off":
      runtime.setMode("off");
      ctx.ui.notify("RV · off — automatic review disabled", "info");
      return;
    case "on": {
      const requested = rest[0] ?? "always";
      const mode = ON_MODES[requested];
      if (!mode) {
        ctx.ui.notify(`RV · usage: /rv on [${Object.keys(ON_MODES).join("|")}]`, "warning");
        return;
      }
      runtime.setMode(mode);
      // agent_end activation is Milestone 2 — do not claim automation exists.
      ctx.ui.notify(
        `RV · mode set to "${mode}" (this session). Automatic review at completion is not wired yet (Milestone 2) — today reviews run via /rv review or the council_audit tool.`,
        "info",
      );
      return;
    }
    case "config":
      ctx.ui.notify(`config: ${runtime.paths.configPath}\nreceipts: ${runtime.paths.receiptsPath}`, "info");
      return;
    case "best":
    case "fuse":
    case "compare":
      ctx.ui.notify(`RV · /rv ${sub} lands in Milestone 3 (ensemble modes). /rv review works today.`, "warning");
      return;
    default:
      ctx.ui.notify(`RV · unknown subcommand "${sub}". Try: status, review, on, off, config`, "warning");
  }
}

export function registerRvCommand(pi: ExtensionAPI, runtime: RVEngine): void {
  pi.registerCommand("rv", {
    description: "Resolve Vector — cross-model review (status | review | on [mode] | off | config)",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "review", "on", "off", "config", "best", "fuse", "compare"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
    },
    handler: (args, ctx) => dispatch(runtime, args, ctx),
  });
}
