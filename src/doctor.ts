/**
 * `/rv doctor` checks, shared by the doctor command and the setup wizard's
 * post-write verification. All output is actionable; credentials are never
 * displayed.
 */
import { access, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { probeReviewerGeneration } from "./health.js";
import { effectiveScope, readLedgerTimestamps } from "./policy.js";
import { resolveReviewer } from "./providers.js";
import type { RVEngine } from "./runtime.js";

/** Highest OMP major version RV is verified against (peer range ^17). */
const SUPPORTED_OMP_MAJOR = 17;

export interface DoctorCheck {
  ok: boolean;
  label: string;
  fix?: string;
}

export interface DoctorOptions {
  /**
   * Run the tiny generation probe per enabled reviewer. Without it doctor
   * only proves endpoint reachability — never generation health.
   */
  probe?: boolean;
}

/** Actionable hint when generation is dead but the endpoint answers HTTP. */
function unresponsiveFix(provider: string, local: boolean): string {
  return local
    ? `generation is unresponsive. Restart the ${provider} service, then run /rv doctor.`
    : `generation is unresponsive at the ${provider} endpoint — check provider status, then /rv reviewer retry.`;
}

export async function runDoctorChecks(
  runtime: RVEngine,
  ctx: ExtensionCommandContext,
  ompVersion: string,
  options: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // 1. Extension loaded + supported OMP version.
  const ompMajor = Number.parseInt(ompVersion.split(".")[0] ?? "0", 10);
  checks.push({
    ok: ompMajor === SUPPORTED_OMP_MAJOR,
    label: `extension loaded on omp ${ompVersion}`,
    fix: ompMajor === SUPPORTED_OMP_MAJOR ? undefined : `RV supports omp ^${SUPPORTED_OMP_MAJOR}.x — upgrade or pin omp`,
  });

  // 2. Config health.
  if (runtime.configCreated) {
    checks.push({
      ok: false,
      label: `no config at ${runtime.paths.configPath}`,
      fix: "run /rv setup (native wizard) or copy resolve-vector.example.json and adjust the roster",
    });
  } else {
    checks.push({ ok: runtime.configErrors.length === 0, label: `config ${runtime.paths.configPath}`, fix: runtime.configErrors[0] });
  }

  // 3. Per reviewer: resolves, credentials (never displayed), circuit state,
  //    local reachability, and — only when asked — generation health.
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
    const circuit = runtime.circuits.snapshot(reviewer.id);
    if (circuit.state !== "closed") {
      checks.push({
        ok: circuit.state === "half_open",
        label: `${reviewer.id}: circuit ${circuit.state}${circuit.reason ? ` (${circuit.reason})` : ""}${circuit.remainingMs > 0 ? ` — ${Math.ceil(circuit.remainingMs / 1000)}s cooldown left` : ""}`,
        fix: circuit.state === "open" ? `/rv reviewer retry ${reviewer.id} probes the seat and closes the circuit on success` : undefined,
      });
    }
    if (reviewer.local) {
      try {
        const response = await fetch(`${model.baseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
        checks.push({
          ok: response.ok,
          label: `${reviewer.id}: endpoint reachable (HTTP only — NOT proof of generation health)`,
          fix: response.ok ? undefined : "start the local server (vllm-mlx / ollama / lm-studio)",
        });
      } catch {
        checks.push({ ok: false, label: `${reviewer.id}: local endpoint ${model.baseUrl} unreachable`, fix: "start the local server (vllm-mlx / ollama / lm-studio)" });
      }
    }
    if (options.probe) {
      const resolved = await resolveReviewer(ctx, reviewer);
      if (!resolved.ok) continue; // already reported above
      // A probe against an open circuit is the one half-open trial.
      if (circuit.state === "open") runtime.circuits.beginProbe(reviewer.id);
      // Deadlines follow seat locality: tight for local (a wedged local server
      // must fail fast), generous enough for slow-but-healthy remote APIs.
      const probe = await probeReviewerGeneration(runtime.complete, resolved.reviewer, {
        connectMs: reviewer.local ? 5_000 : runtime.config.connectTimeoutMs,
        firstTokenMs: reviewer.local ? runtime.config.firstTokenTimeoutMs : runtime.config.remoteFirstTokenTimeoutMs,
      });
      if (probe.ok) {
        runtime.circuits.recordSuccess(reviewer.id);
        checks.push({
          ok: true,
          label: `${reviewer.id}: generation healthy (first meaningful token in ${probe.firstTokenLatencyMs ?? "?"}ms, total ${probe.totalLatencyMs ?? "?"}ms)`,
        });
      } else {
        if (probe.failureCategory) runtime.circuits.recordFailure(reviewer.id, probe.failureCategory);
        checks.push({
          ok: false,
          label: `${reviewer.id}: generation UNHEALTHY — ${probe.failureCategory ?? "error"}: ${probe.error ?? "no meaningful completion"}`,
          fix: unresponsiveFix(reviewer.provider, reviewer.local),
        });
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

  return checks;
}

export function formatDoctorChecks(checks: readonly DoctorCheck[]): string {
  const failed = checks.filter((c) => !c.ok);
  const lines = [`RV doctor — ${checks.length - failed.length}/${checks.length} checks pass`];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.label}`);
    if (!check.ok && check.fix) lines.push(`    fix: ${check.fix}`);
  }
  return lines.join("\n");
}
