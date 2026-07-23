/**
 * `/rv setup` — native setup wizard (ctx.ui only; no windows, no websites).
 *
 * Flow: list authenticated models → pick reviewers (same-family as primary
 * excluded with reasons) → per-seat locality + privacy scope (explicit
 * confirmation required for full-content external) → activation mode →
 * review page → atomic write with backup → runtime reload → doctor checks.
 * Cancellation at ANY stage leaves the config byte-identical.
 */
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ActivationMode, ResolveVectorConfig, ReviewerConfig, ReviewerScope } from "./policy.js";
import { DEFAULT_CONFIG } from "./policy.js";
import { runDoctorChecks, type DoctorCheck } from "./doctor.js";
import type { RVEngine } from "./runtime.js";

export interface CandidateInfo {
  provider: string;
  id: string;
  family: string;
  local: boolean;
  eligible: boolean;
  reason?: string;
}

/** localhost/loopback endpoints are local; everything else is external. */
export function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(baseUrl);
}

/** Authenticated models annotated for the picker; same-family seats excluded. */
export function buildCandidateList(
  models: readonly Model[],
  familyOf: (model: Model) => string,
  primary: { provider: string; id: string; family: string | undefined } | undefined,
  isLocal: (baseUrl: string | undefined) => boolean = isLocalBaseUrl,
): CandidateInfo[] {
  return models.map((model) => {
    const family = familyOf(model);
    const isPrimary = primary !== undefined && model.provider === primary.provider && model.id === primary.id;
    const sameFamily = primary?.family !== undefined && family === primary.family;
    return {
      provider: model.provider,
      id: model.id,
      family,
      local: isLocal(model.baseUrl),
      eligible: !isPrimary && !sameFamily,
      reason: isPrimary
        ? "this IS your primary model"
        : sameFamily
          ? `same family (${family}) as your primary — RV requires cross-family review`
          : undefined,
    };
  });
}

export interface SetupSelection {
  reviewer: ReviewerConfig;
}

export interface SetupPlan {
  mode: ActivationMode;
  reviewers: ReviewerConfig[];
}

/** Merge the wizard's plan into existing config JSON, preserving unrelated keys. */
export function applySetup(existing: Record<string, unknown> | undefined, plan: SetupPlan): Record<string, unknown> {
  const base: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(existing ?? {}) };
  return { ...base, mode: plan.mode, reviewers: plan.reviewers };
}

/** Atomic write: tmp file + rename; existing config backed up first. */
export async function writeConfigAtomic(path: string, config: Record<string, unknown>): Promise<string | undefined> {
  let backup: string | undefined;
  try {
    await readFile(path, "utf8");
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backup);
  } catch {
    backup = undefined; // no existing config — nothing to back up
  }
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return backup;
}

const MODES: { id: ActivationMode; label: string; hint: string }[] = [
  { id: "manual", label: "manual (recommended)", hint: "reviews run only when you ask — safest way to learn RV" },
  { id: "auto", label: "auto", hint: "review consequential completions (files changed, diagnoses, recommendations…)" },
  { id: "always", label: "always", hint: "review every substantive completion — most coverage, most reviewer traffic" },
  { id: "sample", label: "sample", hint: "review a random 10% of otherwise quiet turns" },
];

function formatDoctor(checks: readonly DoctorCheck[]): string {
  const failed = checks.filter((c) => !c.ok);
  const lines = [`RV doctor — ${checks.length - failed.length}/${checks.length} checks pass`];
  for (const check of checks) {
    lines.push(`  ${check.ok ? "✓" : "✗"} ${check.label}`);
    if (!check.ok && check.fix) lines.push(`    fix: ${check.fix}`);
  }
  return lines.join("\n");
}

/** The wizard. Every `undefined` from the UI is a cancellation: write nothing. */
export async function runSetupWizard(runtime: RVEngine, ctx: ExtensionCommandContext, ompVersion: string): Promise<void> {
  const ui = ctx.ui;
  const models = ctx.models.list();
  if (models.length === 0) {
    ui.notify("RV setup: no authenticated models in this session — configure a provider first, then rerun /rv setup.", "warning");
    return;
  }
  const primary = ctx.model ?? ctx.models.current();
  const primaryFamily = primary ? ctx.models.family(primary) : undefined;

  // 1. Candidates with same-family exclusion, explained.
  const candidatesRaw = buildCandidateList(models, (m) => ctx.models.family(m), primary ? { provider: primary.provider, id: primary.id, family: primaryFamily } : undefined);
  const byKey = new Map(candidatesRaw.map((c) => [`${c.provider}/${c.id}`, c]));
  const candidates = models.map((model) => {
    const info = byKey.get(`${model.provider}/${model.id}`) as CandidateInfo;
    return { model, family: info.family, local: info.local, eligible: info.eligible, reason: info.reason };
  });
  const excluded = candidates.filter((c) => !c.eligible);
  if (excluded.length > 0) {
    ui.notify(
      `RV setup: ${excluded.length} model(s) unavailable as reviewers:\n${excluded.map((c) => `  ${c.model.provider}/${c.model.id} — ${c.reason}`).join("\n")}`,
      "info",
    );
  }
  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length === 0) {
    ui.notify(
      "RV setup: no eligible reviewers — every authenticated model shares your primary's family. Add a different-family model (any provider) and rerun /rv setup.",
      "warning",
    );
    return;
  }

  // 2. Multi-select reviewers (loop until Done/Cancel).
  const selected: typeof eligible = [];
  for (;;) {
    const remaining = eligible.filter((c) => !selected.includes(c));
    if (remaining.length === 0) break;
    const options = remaining.map((c) => ({
      label: `${c.model.provider}/${c.model.id}`,
      description: `family ${c.family} · ${c.local ? "local endpoint" : "external endpoint"}`,
    }));
    if (selected.length > 0) options.push({ label: "Done selecting", description: `${selected.length} reviewer(s) chosen` });
    const picked = await ui.select(
      selected.length === 0 ? "RV setup: choose a reviewer model" : "RV setup: add another reviewer, or finish",
      options,
    );
    if (picked === undefined) return; // cancelled — nothing written
    if (picked === "Done selecting") break;
    const choice = remaining.find((c) => `${c.model.provider}/${c.model.id}` === picked);
    if (choice) selected.push(choice);
    if (selected.length === eligible.length) break;
  }
  if (selected.length === 0) return; // cancelled with no selection

  // 3. Per-seat privacy scope. external-allowed requires explicit opt-in.
  const reviewers: ReviewerConfig[] = [];
  for (const [index, candidate] of selected.entries()) {
    const name = `${candidate.model.provider}/${candidate.model.id}`;
    let scope: ReviewerScope;
    if (candidate.local) {
      scope = "local-only";
      ui.notify(`${name}: local endpoint detected — content never leaves this machine (scope local-only).`, "info");
    } else {
      const allowFull = await ui.confirm(
        `${name}: external endpoint`,
        "Send FULL unredacted content to this endpoint?\n\nNo  = external-redacted (recommended): secrets are stripped first, but context still leaves the machine.\nYes = external-allowed: you fully trust this endpoint with raw content.",
      );
      scope = allowFull ? "external-allowed" : "external-redacted";
    }
    reviewers.push({
      id: name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase(),
      provider: candidate.model.provider,
      model: candidate.model.id,
      family: candidate.family,
      role: index === 0 ? "critic" : "verifier",
      local: candidate.local,
      scope,
      enabled: true,
      order: index + 1,
    });
  }

  // 4. Activation mode.
  const modeLabel = await ui.select(
    "RV setup: activation mode",
    MODES.map((m) => ({ label: m.label, description: m.hint })),
  );
  if (modeLabel === undefined) return; // cancelled
  const mode = MODES.find((m) => m.label === modeLabel)?.id ?? "manual";

  // 5. Review page — nothing written until confirmed here.
  const external = reviewers.filter((r) => !r.local);
  const lines = [
    "RV setup — review before writing:",
    "",
    "reviewers:",
    ...reviewers.map((r) => `  ${r.order}. ${r.provider}/${r.model} (${r.family}, ${r.role}) [${r.local ? "local" : "remote"}, scope ${r.scope}]`),
    "",
    external.length === 0
      ? "content recipients: none — everything stays on this machine"
      : `content recipients: ${external.map((r) => `${r.provider} (${r.scope})`).join(", ")} — redaction is not a complete privacy boundary`,
    `external budgets: ${runtime.config.maxExternalAuditsPerHour}/hour, ${runtime.config.maxExternalAuditsPerDay}/day`,
    `activation mode: ${mode}`,
    "",
    `write to ${runtime.paths.configPath}${runtime.configCreated ? " (new file)" : " (existing config backed up first)"}`,
  ];
  const confirmed = await ui.confirm("RV setup: write this configuration?", lines.join("\n"));
  if (!confirmed) return; // cancelled — config unchanged

  // 6. Preserve unrelated settings, write atomically with backup, reload runtime.
  let existing: Record<string, unknown> | undefined;
  try {
    existing = JSON.parse(await readFile(runtime.paths.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = undefined;
  }
  const merged = applySetup(existing, { mode, reviewers });
  const backup = await writeConfigAtomic(runtime.paths.configPath, merged);
  await runtime.reload();
  ui.notify(`RV · config written${backup ? ` (backup: ${backup})` : ""} — runtime reloaded, no restart needed.`, "info");

  // 7. Doctor against the new config — including the tiny generation probe:
  //    endpoint reachability alone is not proof a reviewer can generate.
  const checks = await runDoctorChecks(runtime, ctx, ompVersion, { probe: true });
  const failed = checks.filter((c) => !c.ok);
  ui.notify(formatDoctor(checks), failed.length === 0 ? "info" : "warning");
  ui.notify(
    failed.length === 0 ? "RV · setup complete. Try /rv review, or /rv status to see your council." : "RV · setup saved but some checks failed — fix the items above, then /rv doctor again.",
    failed.length === 0 ? "info" : "warning",
  );
}
