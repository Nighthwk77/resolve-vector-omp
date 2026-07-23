/**
 * `/rv` slash-command routing. Every subcommand funnels into RVRuntime —
 * manual review and (later) automatic activation share the engine and receipts.
 * Plan-gate subcommands (proceed/revise/dismiss/details) route to the
 * ActivationController facade registered alongside.
 */
import type { ExtensionCommandContext, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { lastExchangeFromEntries } from "./activation.js";
import type { CouncilProgressEvent } from "./council.js";
import { formatDoctorChecks, runDoctorChecks } from "./doctor.js";
import { probeReviewerGeneration } from "./health.js";
import type { ActivationMode } from "./policy.js";
import { effectiveScope, readLedgerTimestamps } from "./policy.js";
import { resolveReviewer } from "./providers.js";
import { renderStatusLine, renderVerdict } from "./render.js";
import type { RVEngine } from "./runtime.js";
import { detailedGlmUsage, fetchGlmUsage } from "./provider-usage.js";
import { runSetupWizard } from "./setup.js";

/** Plan-gate facade the ActivationController implements for gate subcommands. */
export interface ReviewFlowGate {
  proceedWithPlan: (ctx: ExtensionContext, instructions?: string) => void;
  dismissGate: (ctx: ExtensionContext) => void;
  gateDetails: (ctx: ExtensionContext) => void;
}

/** "A and B" / "A, B and C" — the progress-line roster format. */
function formatReviewerList(ids: readonly string[]): string {
  if (ids.length <= 1) return ids.join("");
  if (ids.length === 2) return `${ids[0]} and ${ids[1]}`;
  return `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`;
}

/** Map council progress events to visible `RV · …` notifications. */
function progressNotifier(ctx: ExtensionCommandContext): (event: CouncilProgressEvent) => void {
  return (event) => {
    switch (event.type) {
      case "council_started":
        ctx.ui.notify(`RV · reviewing with ${formatReviewerList(event.reviewerIds)}`, "info");
        return;
      case "reviewer_unavailable":
        ctx.ui.notify(
          event.remaining.length > 0
            ? `RV · ${event.reviewerId} unavailable (${event.detail}) — continuing with ${formatReviewerList(event.remaining)}`
            : `RV · ${event.reviewerId} unavailable (${event.detail})`,
          "warning",
        );
        return;
      case "reviewer_skipped":
        ctx.ui.notify(`RV · ${event.reviewerId} skipped — ${event.detail}`, "warning");
        return;
    }
  };
}

async function cmdDoctor(runtime: RVEngine, ctx: ExtensionCommandContext, ompVersion: string, probe: boolean): Promise<void> {
  const checks = await runDoctorChecks(runtime, ctx, ompVersion, { probe });
  const failed = checks.filter((c) => !c.ok);
  ctx.ui.notify(formatDoctorChecks(checks), failed.length === 0 ? "info" : "warning");
}
/** Last user goal + last assistant answer on the current branch. */
export function lastExchange(ctx: ExtensionCommandContext): { goal?: string; proposal?: string } {
  return lastExchangeFromEntries(ctx.sessionManager.getBranch());
}

async function cmdStatus(runtime: RVEngine, ctx: ExtensionCommandContext, probe: boolean): Promise<void> {
  const { config } = runtime;
  const lines: string[] = [
    `Resolve Vector — mode: ${config.mode} · council: ${config.defaultCouncilMode}`,
  ];
  // Budget usage + remaining allowance (from the shared ledger).
  const now = Date.now();
  const stamps = await readLedgerTimestamps(runtime.paths.ledgerPath);
  const inHour = stamps.filter((t) => t >= now - 3_600_000).length;
  const inDay = stamps.filter((t) => t >= now - 86_400_000).length;
  lines.push(
    `external budget: ${inHour}/${config.maxExternalAuditsPerHour} used this hour (${Math.max(0, config.maxExternalAuditsPerHour - inHour)} left) · ${inDay}/${config.maxExternalAuditsPerDay} today (${Math.max(0, config.maxExternalAuditsPerDay - inDay)} left)`,
  );
  if (runtime.configCreated) lines.push(`config: no file at ${runtime.paths.configPath} — defaults in effect`);
  for (const error of runtime.configErrors) lines.push(`config error: ${error}`);
  if (config.reviewers.length === 0) {
    lines.push("reviewers: none configured — add seats to resolve-vector.json");
  } else {
    lines.push("reviewers (and what content each receives):");
    for (const reviewer of config.reviewers) {
      const scope = effectiveScope(reviewer);
      const receives =
        reviewer.local
          ? "nothing leaves the machine"
          : scope === "local-only"
            ? "BLOCKED by policy (external seat, local-only scope)"
            : scope === "external-allowed"
              ? "FULL content externally (trusted endpoint)"
              : "redacted content externally (not a complete privacy boundary)";
      const flags = [reviewer.local ? "local" : "remote", reviewer.enabled ? "enabled" : "disabled", reviewer.trigger ?? "always", `scope:${scope}`];
      lines.push(`  ${reviewer.order}. ${reviewer.id} — ${reviewer.provider}/${reviewer.model} (${reviewer.family}, ${reviewer.role}) [${flags.join(", ")}]`);
      lines.push(`     → ${receives}`);
      const circuit = runtime.circuits.snapshot(reviewer.id);
      if (circuit.state !== "closed") {
        lines.push(
          `     → circuit ${circuit.state}${circuit.reason ? ` (${circuit.reason})` : ""}${circuit.remainingMs > 0 ? ` — ${Math.ceil(circuit.remainingMs / 1000)}s cooldown left; /rv reviewer retry ${reviewer.id} to probe` : ""}`,
        );
      }
    }
  }
  if (probe) {
    const probeLines: string[] = ["generation probe (tiny completion, strict first-token deadline):"];
    for (const reviewer of config.reviewers) {
      if (!reviewer.enabled) continue;
      const resolved = await resolveReviewer(ctx, reviewer);
      if (!resolved.ok) {
        probeLines.push(`  ✗ ${reviewer.id}: ${resolved.detail}`);
        continue;
      }
      const result = await probeReviewerGeneration(runtime.complete, resolved.reviewer);
      probeLines.push(
        result.ok
          ? `  ✓ ${reviewer.id}: generation healthy (first token ${result.firstTokenLatencyMs ?? "?"}ms)`
          : `  ✗ ${reviewer.id}: endpoint reachable ≠ generation healthy — ${result.failureCategory ?? "error"}: ${result.error ?? ""}`,
      );
    }
    lines.push(...probeLines);
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
  const verdict = await runtime.runReview(ctx, {
    goal: goal ?? "(goal unavailable — review the answer on its own merits)",
    proposal,
    primaryFamily: ctx.model ? ctx.models.family(ctx.model) : undefined,
    activationReason: "manual_command",
    onProgress: progressNotifier(ctx),
  });
  ctx.ui.notify(renderStatusLine(verdict), verdict.status === "pass" ? "info" : "warning");
  ctx.ui.notify(renderVerdict(verdict), "info");
}

const ON_MODES: Record<string, ActivationMode> = { auto: "auto", always: "always", sample: "sample" };

async function cmdReviewerRetry(runtime: RVEngine, ctx: ExtensionCommandContext, id: string | undefined): Promise<void> {
  if (!id) {
    ctx.ui.notify("RV · usage: /rv reviewer retry <id> — one half-open probe; closes the circuit on success", "warning");
    return;
  }
  const reviewer = runtime.config.reviewers.find((r) => r.id === id);
  if (!reviewer) {
    ctx.ui.notify(`RV · no reviewer with id "${id}" in ${runtime.paths.configPath}`, "warning");
    return;
  }
  const circuit = runtime.circuits.snapshot(id);
  if (circuit.state === "closed") {
    ctx.ui.notify(`RV · ${id}: circuit already closed — nothing to retry`, "info");
    return;
  }
  const resolved = await resolveReviewer(ctx, reviewer);
  if (!resolved.ok) {
    ctx.ui.notify(`RV · ${id}: cannot probe — ${resolved.detail}`, "warning");
    return;
  }
  runtime.circuits.beginProbe(id);
  ctx.ui.notify(`RV · probing ${id} (half-open trial)…`, "info");
  const probe = await probeReviewerGeneration(runtime.complete, resolved.reviewer, {
    connectMs: reviewer.local ? 5_000 : runtime.config.connectTimeoutMs,
    firstTokenMs: reviewer.local ? runtime.config.firstTokenTimeoutMs : runtime.config.remoteFirstTokenTimeoutMs,
  });
  if (probe.ok) {
    runtime.circuits.recordSuccess(id);
    ctx.ui.notify(`RV · ${id}: generation healthy again (first token ${probe.firstTokenLatencyMs ?? "?"}ms) — circuit closed`, "info");
  } else {
    if (probe.failureCategory) runtime.circuits.recordFailure(id, probe.failureCategory);
    const remaining = Math.ceil(runtime.circuits.snapshot(id).remainingMs / 1000);
    ctx.ui.notify(
      `RV · ${id}: still unresponsive (${probe.failureCategory ?? "error"}) — circuit re-opened for ${remaining}s.\n${
        reviewer.local
          ? `${id} generation is unresponsive. Restart the ${reviewer.provider} service, then run /rv doctor.`
          : `Check the ${reviewer.provider} endpoint, then retry.`
      }`,
      "warning",
    );
  }
}

async function dispatch(runtime: RVEngine, args: string, ctx: ExtensionCommandContext, ompVersion: string, gate?: ReviewFlowGate): Promise<void> {
  const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  switch (sub) {
    case "proceed":
      if (!gate) return ctx.ui.notify("RV · review flow not active in this session", "warning");
      return gate.proceedWithPlan(ctx as unknown as ExtensionContext);
    case "revise": {
      if (!gate) return ctx.ui.notify("RV · review flow not active in this session", "warning");
      const instructions = rest.join(" ");
      if (!instructions) {
        ctx.ui.notify("RV · usage: /rv revise <instructions> — execute the plan with your steering", "warning");
        return;
      }
      return gate.proceedWithPlan(ctx as unknown as ExtensionContext, instructions);
    }
    case "dismiss":
      if (!gate) return ctx.ui.notify("RV · review flow not active in this session", "warning");
      return gate.dismissGate(ctx as unknown as ExtensionContext);
    case "details":
      if (!gate) return ctx.ui.notify("RV · review flow not active in this session", "warning");
      return gate.gateDetails(ctx as unknown as ExtensionContext);
    case "status":
      return cmdStatus(runtime, ctx, rest.includes("probe"));
    case "doctor":
      return cmdDoctor(runtime, ctx, ompVersion, rest.includes("probe"));
    case "reviewer":
      return cmdReviewerRetry(runtime, ctx, rest[0] === "retry" ? rest[1] : undefined);
    case "setup":
      return runSetupWizard(runtime, ctx, ompVersion);
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
      ctx.ui.notify(
        `RV · ${mode} — automatic review at completion enabled (this session). Not persisted to disk.`,
        "info",
      );
      return;
    }
    case "config":
      ctx.ui.notify(`config: ${runtime.paths.configPath}\nreceipts: ${runtime.paths.receiptsPath}`, "info");
      return;
    case "usage": {
      const usage = await fetchGlmUsage();
      ctx.ui.notify(detailedGlmUsage(usage), usage.ok ? "info" : "warning");
      return;
    }
    case "best":
    case "fuse":
    case "compare": {
      const mode = sub === "fuse" ? "fusion" : sub;
      const count = rest[0] !== undefined ? Number.parseInt(rest[0], 10) : runtime.config.candidateCount;
      if (!Number.isInteger(count) || count < 2 || count > 8) {
        ctx.ui.notify(`RV · /rv ${sub} [count] — count must be an integer 2-8`, "warning");
        return;
      }
      if (runtime.config.reviewers.filter((r) => r.enabled).length < 2) {
        ctx.ui.notify(`RV · /rv ${sub} needs at least 2 enabled reviewers in ${runtime.paths.configPath}`, "warning");
        return;
      }
      const { goal } = lastExchange(ctx);
      if (!goal) {
        ctx.ui.notify("RV · no goal in this session to build candidates from", "warning");
        return;
      }
      ctx.ui.notify(`RV · ${mode} of ${count} — generating candidates…`, "info");
      const verdict = await runtime.runEnsemble(ctx, {
        mode,
        goal,
        candidateCount: count,
        primaryFamily: ctx.model ? ctx.models.family(ctx.model) : undefined,
        activationReason: "manual_command",
      });
      ctx.ui.notify(renderStatusLine(verdict), verdict.status === "pass" ? "info" : "warning");
      ctx.ui.notify(renderVerdict(verdict), "info");
      return;
    }
    default:
      ctx.ui.notify(`RV · unknown subcommand "${sub}". Try: setup, status, usage, doctor, review, reviewer retry <id>, proceed, revise, dismiss, details, on, off, config`, "warning");
  }
}

export function registerRvCommand(pi: ExtensionAPI, runtime: RVEngine, gate?: ReviewFlowGate): void {
  // Read through the injected namespace: a static value import of VERSION from
  // the package root would eagerly load omp's native addons in plain tests.
  const ompVersion: string = (pi.pi as { VERSION?: string } | undefined)?.VERSION ?? "unknown";
  pi.registerCommand("rv", {
    description: "Resolve Vector — cross-model review (setup | status [probe] | usage | doctor [probe] | review | reviewer retry <id> | proceed | revise <i> | dismiss | details | on [mode] | off | config)",
    getArgumentCompletions: (prefix) => {
      const subs = ["setup", "status", "usage", "doctor", "review", "reviewer", "proceed", "revise", "dismiss", "details", "on", "off", "config", "best", "fuse", "compare"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
    },
    handler: (args, ctx) => dispatch(runtime, args, ctx, ompVersion, gate),
  });
}
