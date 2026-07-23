/**
 * `/rv` slash-command routing. Every subcommand funnels into RVRuntime —
 * manual review and (later) automatic activation share the engine and receipts.
 */
import { access, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lastExchangeFromEntries } from "./activation.js";
import type { ActivationMode } from "./policy.js";
import { effectiveScope, readLedgerTimestamps } from "./policy.js";
import { renderStatusLine, renderVerdict } from "./render.js";
import type { RVEngine } from "./runtime.js";
import { detailedGlmUsage, fetchGlmUsage } from "./provider-usage.js";

/** Highest OMP major version RV is verified against (peer range ^17). */
const SUPPORTED_OMP_MAJOR = 17;

interface DoctorCheck {
  ok: boolean;
  label: string;
  fix?: string;
}

async function cmdDoctor(runtime: RVEngine, ctx: ExtensionCommandContext, ompVersion: string): Promise<void> {
  const checks: DoctorCheck[] = [];

  // 1. Extension loaded + supported OMP version.
  const ompMajor = Number.parseInt(ompVersion.split(".")[0] ?? "0", 10);
  checks.push({
    ok: ompMajor === SUPPORTED_OMP_MAJOR,
    label: `extension loaded on omp ${ompVersion}`,
    fix: ompMajor === SUPPORTED_OMP_MAJOR ? undefined : `RV ${"supports"} omp ^${SUPPORTED_OMP_MAJOR}.x — upgrade or pin omp`,
  });

  // 2. Config health.
  if (runtime.configCreated) {
    checks.push({
      ok: false,
      label: `no config at ${runtime.paths.configPath}`,
      fix: "copy resolve-vector.example.json there and adjust the roster",
    });
  } else {
    checks.push({ ok: runtime.configErrors.length === 0, label: `config ${runtime.paths.configPath}`, fix: runtime.configErrors[0] });
  }

  // 3. Per reviewer: resolves, credentials (never displayed), local reachability.
  for (const reviewer of runtime.config.reviewers) {
    if (!reviewer.enabled) continue;
    const model = ctx.models.resolve(`${reviewer.provider}/${reviewer.model}`) ?? ctx.models.resolve(reviewer.model);
    if (!model) {
      checks.push({
        ok: false,
        label: `${reviewer.id}: ${reviewer.provider}/${reviewer.model} does not resolve`,
        fix: "find valid ids with /model inside omp (authenticated model picker) or check providers in ~/.omp/agent/models.yml, then update the reviewer entry",
      });
      continue;
    }
    const family = ctx.models.family(model);
    const key = await ctx.modelRegistry.getApiKey(model);
    if (!reviewer.local && !key) {
      checks.push({ ok: false, label: `${reviewer.id}: no credential for ${reviewer.provider}`, fix: "run /login or set the provider API key" });
    } else {
      checks.push({ ok: true, label: `${reviewer.id}: resolves (${family}), credential ${key ? "present (redacted)" : "not required"}` });
    }
    if (reviewer.local) {
      try {
        const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
        checks.push({ ok: response.ok, label: `${reviewer.id}: local endpoint ${model.baseUrl} reachable`, fix: response.ok ? undefined : "start the local server (vllm-mlx / ollama / lm-studio)" });
      } catch {
        checks.push({ ok: false, label: `${reviewer.id}: local endpoint ${model.baseUrl} unreachable`, fix: "start the local server (vllm-mlx / ollama / lm-studio)" });
      }
    }
  }

  // 4. Receipt + budget paths writable.
  for (const [label, path] of [
    ["receipts", runtime.paths.receiptsPath],
    ["budget ledger", runtime.paths.ledgerPath],
  ] as const) {
    try {
      await access(dirname(path));
      await appendFile(path, "", "utf8");
      checks.push({ ok: true, label: `${label} path writable` });
    } catch {
      checks.push({ ok: false, label: `${label} path NOT writable: ${path}`, fix: "check permissions on the agent directory" });
    }
  }

  // 5. Privacy policy + external budget.
  const external = runtime.config.reviewers.filter((r) => r.enabled && !r.local && effectiveScope(r) !== "local-only");
  checks.push({
    ok: true,
    label:
      external.length === 0
        ? "privacy: no external seat receives content (local-only posture)"
        : `privacy: ${external.length} external seat(s) receive content: ${external.map((r) => `${r.id} (${effectiveScope(r)})`).join(", ")} — redaction is not a complete privacy boundary`,
  });
  const now = Date.now();
  const stamps = await readLedgerTimestamps(runtime.paths.ledgerPath);
  const inHour = stamps.filter((t) => t >= now - 3_600_000).length;
  const inDay = stamps.filter((t) => t >= now - 86_400_000).length;
  checks.push({
    ok: inHour < runtime.config.maxExternalAuditsPerHour,
    label: `external budget: ${inHour}/${runtime.config.maxExternalAuditsPerHour} this hour, ${inDay}/${runtime.config.maxExternalAuditsPerDay} today`,
    fix: inHour >= runtime.config.maxExternalAuditsPerHour ? "hourly external budget exhausted — wait or raise maxExternalAuditsPerHour" : undefined,
  });

  const failed = checks.filter((c) => !c.ok);
  const lines = [`RV doctor — ${checks.length - failed.length}/${checks.length} checks pass`];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.label}`);
    if (!check.ok && check.fix) lines.push(`    fix: ${check.fix}`);
  }
  ctx.ui.notify(lines.join("\n"), failed.length === 0 ? "info" : "warning");
}

/** Last user goal + last assistant answer on the current branch. */
export function lastExchange(ctx: ExtensionCommandContext): { goal?: string; proposal?: string } {
  return lastExchangeFromEntries(ctx.sessionManager.getBranch());
}

async function cmdStatus(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
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

async function dispatch(runtime: RVEngine, args: string, ctx: ExtensionCommandContext, ompVersion: string): Promise<void> {
  const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  switch (sub) {
    case "status":
      return cmdStatus(runtime, ctx);
    case "doctor":
      return cmdDoctor(runtime, ctx, ompVersion);
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
      ctx.ui.notify(`RV · unknown subcommand "${sub}". Try: status, usage, review, on, off, config`, "warning");
  }
}

export function registerRvCommand(pi: ExtensionAPI, runtime: RVEngine): void {
  // Read through the injected namespace: a static value import of VERSION from
  // the package root would eagerly load omp's native addons in plain tests.
  const ompVersion: string = (pi.pi as { VERSION?: string } | undefined)?.VERSION ?? "unknown";
  pi.registerCommand("rv", {
    description: "Resolve Vector — cross-model review (status | usage | doctor | review | on [mode] | off | config)",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "usage", "doctor", "review", "on", "off", "config", "best", "fuse", "compare"];
      return subs.filter((s) => s.startsWith(prefix)).map((s) => ({ label: s, value: s }));
    },
    handler: (args, ctx) => dispatch(runtime, args, ctx, ompVersion),
  });
}
