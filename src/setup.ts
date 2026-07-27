/**
 * `/rv setup` — native setup wizard. UI stays inside OMP; optional web
 * discovery is headless and read-only (no consultations, no focused windows).
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
import type {
  ActivationMode,
  PlanMode,
  ResolveVectorConfig,
  ReviewerConfig,
  ReviewerScope,
  ReviewerWorkflow,
} from "./policy.js";
import { DEFAULT_CONFIG } from "./policy.js";
import { runDoctorChecks, type DoctorCheck } from "./doctor.js";
import type { RVEngine } from "./runtime.js";
import { ADAPTERS } from "./web/adapters.mjs";
import { isChromiumInstalled, type StateDetection } from "./web/manager.js";

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
  planMode: PlanMode;
  reviewers: ReviewerConfig[];
  webOptIn: boolean;
}

/** Merge the wizard's plan into existing config JSON, preserving unrelated keys. */
export function applySetup(existing: Record<string, unknown> | undefined, plan: SetupPlan): Record<string, unknown> {
  const base: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(existing ?? {}) };
  const oldPlanning = typeof base.planning === "object" && base.planning !== null ? base.planning : {};
  const oldWeb = typeof base.webAdvisors === "object" && base.webAdvisors !== null ? base.webAdvisors : {};
  return {
    ...base,
    mode: plan.mode,
    reviewers: plan.reviewers,
    planning: { ...oldPlanning, mode: plan.planMode },
    webAdvisors: { ...oldWeb, optIn: plan.webOptIn },
  };
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

const PLAN_MODES: { id: PlanMode; label: string; hint: string }[] = [
  { id: "ask", label: "ask (recommended)", hint: "review the plan, explain concerns clearly, then wait for your decision" },
  { id: "auto", label: "auto", hint: "accepted safe plans continue automatically; risky or split plans ask you" },
  { id: "off", label: "off", hint: "do not run pre-execution plan reviews" },
];

type UsableWebState = Extract<StateDetection["state"], "ready_authenticated" | "ready_anonymous">;

export interface WebSetupCandidate {
  id: string;
  provider: string;
  model: string;
  family: string;
  url: string;
  state: UsableWebState;
}

export interface SetupWizardDeps {
  /** Test seam; production scans every supported web advisor when Chromium exists. */
  discoverWebCandidates?: (runtime: RVEngine, notify: (message: string) => void) => Promise<WebSetupCandidate[]>;
}

/**
 * Inspect every supported web advisor without consulting it. Only providers
 * with a real usable input (authenticated or anonymous) become setup choices.
 */
export async function discoverUsableWebCandidates(
  runtime: RVEngine,
  notify: (message: string) => void,
  options: { chromiumInstalled?: () => Promise<boolean> } = {},
): Promise<WebSetupCandidate[]> {
  if (!(await (options.chromiumInstalled ?? isChromiumInstalled)())) return [];
  if (typeof runtime.web?.bridge?.detectState !== "function") return [];

  const entries = Object.entries(ADAPTERS);
  notify(`RV setup: checking ${entries.length} browser advisors for authenticated or anonymous access…`);
  const found: WebSetupCandidate[] = [];
  // Keep browser pressure modest: two sites at a time, no prompts and no retries.
  let next = 0;
  const workers = Array.from({ length: Math.min(2, entries.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= entries.length) return;
      const [id, adapter] = entries[index];
      try {
        const detected = await runtime.web.bridge.detectState(id);
        if (detected.state === "ready_authenticated" || detected.state === "ready_anonymous") {
          found.push({
            id: `web-${id}`,
            provider: `web:${id}`,
            model: id,
            family: adapter.family,
            url: adapter.url,
            state: detected.state,
          });
        }
      } catch {
        // One broken/slow site must not block setup or hide the usable sites.
      }
    }
  });
  await Promise.all(workers);
  return found.sort((a, b) => a.provider.localeCompare(b.provider));
}

interface SelectableCandidate {
  key: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  family: string;
  local: boolean;
}

async function selectCouncil(
  ui: ExtensionCommandContext["ui"],
  title: string,
  candidates: readonly SelectableCandidate[],
  options: { sameAs?: readonly SelectableCandidate[] } = {},
): Promise<SelectableCandidate[] | undefined> {
  const selected: SelectableCandidate[] = [];
  for (;;) {
    const remaining = candidates.filter((candidate) => !selected.some((picked) => picked.key === candidate.key));
    const choices = remaining.map((candidate) => ({ label: candidate.label, description: candidate.description }));
    if (selected.length === 0 && options.sameAs && options.sameAs.length > 0) {
      choices.unshift({
        label: "Use issue/completion reviewers",
        description: `${options.sameAs.length} reviewer(s) — you can still configure the workflows separately later`,
      });
    }
    choices.push(
      selected.length > 0
        ? { label: "Done selecting", description: `${selected.length} reviewer(s) chosen for this workflow` }
        : { label: "No reviewers for this workflow", description: "leave this workflow disabled" },
    );
    const picked = await ui.select(title, choices);
    if (picked === undefined) return undefined;
    if (picked === "Use issue/completion reviewers") return [...(options.sameAs ?? [])];
    if (picked === "No reviewers for this workflow") return [];
    if (picked === "Done selecting") return selected;
    const candidate = remaining.find((item) => item.label === picked);
    if (candidate) selected.push(candidate);
  }
}

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
export async function runSetupWizard(
  runtime: RVEngine,
  ctx: ExtensionCommandContext,
  ompVersion: string,
  deps: SetupWizardDeps = {},
): Promise<void> {
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
  const eligibleModels: SelectableCandidate[] = candidates.filter((c) => c.eligible).map((candidate) => ({
    key: `${candidate.model.provider}/${candidate.model.id}`,
    label: `${candidate.model.provider}/${candidate.model.id}`,
    description: `API/model · family ${candidate.family} · ${candidate.local ? "local endpoint" : "external endpoint"}`,
    provider: candidate.model.provider,
    model: candidate.model.id,
    family: candidate.family,
    local: candidate.local,
  }));

  const discoverWeb = deps.discoverWebCandidates ?? discoverUsableWebCandidates;
  const webCandidates = await discoverWeb(runtime, (message) => ui.notify(message, "info"));
  const eligibleWeb: SelectableCandidate[] = webCandidates
    .filter((candidate) => candidate.family !== primaryFamily)
    .map((candidate) => ({
      key: candidate.provider,
      label: candidate.provider,
      description: `browser advisor · family ${candidate.family} · ${candidate.state === "ready_authenticated" ? "signed in" : "anonymous access"} · ${candidate.url}`,
      provider: candidate.provider,
      model: candidate.model,
      family: candidate.family,
      local: false,
    }));
  if (webCandidates.length > eligibleWeb.length) {
    ui.notify("RV setup: same-family browser advisors were excluded from cross-family review.", "info");
  }

  const eligible = [...eligibleModels, ...eligibleWeb];
  if (eligible.length === 0) {
    ui.notify(
      "RV setup: no eligible reviewers — add a different-family API/local model, or make a supported browser advisor usable and rerun /rv setup.",
      "warning",
    );
    return;
  }

  // 2. Independent councils: exact selection determines how many seats each
  // workflow consults. A seat may belong to one workflow or both.
  const completionSelected = await selectCouncil(ui, "RV setup: reviewers for completed work and issues", eligible);
  if (completionSelected === undefined) return;
  const planningSelected = await selectCouncil(ui, "RV setup: reviewers for OMP plans before edits", eligible, {
    sameAs: completionSelected,
  });
  if (planningSelected === undefined) return;
  if (completionSelected.length === 0 && planningSelected.length === 0) {
    ui.notify("RV setup: no reviewers selected for either workflow — configuration unchanged.", "info");
    return;
  }

  // 3. Per-seat privacy scope. external-allowed requires explicit opt-in.
  const reviewers: ReviewerConfig[] = [];
  const unique = eligible.filter(
    (candidate) =>
      completionSelected.some((picked) => picked.key === candidate.key) ||
      planningSelected.some((picked) => picked.key === candidate.key),
  );
  for (const [index, candidate] of unique.entries()) {
    const name = candidate.label;
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
      provider: candidate.provider,
      model: candidate.model,
      family: candidate.family,
      role: index === 0 ? "critic" : "verifier",
      local: candidate.local,
      scope,
      enabled: true,
      order: index + 1,
      workflows: [
        ...(completionSelected.some((picked) => picked.key === candidate.key) ? (["completion_review"] as ReviewerWorkflow[]) : []),
        ...(planningSelected.some((picked) => picked.key === candidate.key) ? (["plan_review"] as ReviewerWorkflow[]) : []),
      ],
    });
  }

  // 4. Independent activation modes.
  const modeLabel = await ui.select(
    "RV setup: completed-work/issue review mode",
    MODES.map((m) => ({ label: m.label, description: m.hint })),
  );
  if (modeLabel === undefined) return; // cancelled
  const mode = MODES.find((m) => m.label === modeLabel)?.id ?? "manual";
  let planMode: PlanMode = "off";
  if (planningSelected.length > 0) {
    const planModeLabel = await ui.select(
      "RV setup: pre-execution plan review mode",
      PLAN_MODES.map((item) => ({ label: item.label, description: item.hint })),
    );
    if (planModeLabel === undefined) return;
    planMode = PLAN_MODES.find((item) => item.label === planModeLabel)?.id ?? "ask";
  }

  // 5. Review page — nothing written until confirmed here.
  const external = reviewers.filter((r) => !r.local);
  const completionNames = reviewers.filter((r) => r.workflows?.includes("completion_review")).map((r) => r.id);
  const planningNames = reviewers.filter((r) => r.workflows?.includes("plan_review")).map((r) => r.id);
  const hasWeb = reviewers.some((r) => r.provider.startsWith("web:"));
  const lines = [
    "RV setup — review before writing:",
    "",
    "reviewers:",
    ...reviewers.map(
      (r) =>
        `  ${r.order}. ${r.provider}/${r.model} (${r.family}, ${r.role}) [${r.local ? "local" : "remote"}, scope ${r.scope}, ${r.workflows?.join(" + ")}]`,
    ),
    "",
    `completed work/issues (${completionNames.length}): ${completionNames.join(", ") || "disabled"}`,
    `planning (${planningNames.length}, mode ${planMode}): ${planningNames.join(", ") || "disabled"}`,
    "",
    external.length === 0
      ? "content recipients: none — everything stays on this machine"
      : `content recipients: ${external.map((r) => `${r.provider} (${r.scope})`).join(", ")} — redaction is not a complete privacy boundary`,
    `external budgets: ${runtime.config.maxExternalAuditsPerHour}/hour, ${runtime.config.maxExternalAuditsPerDay}/day`,
    `activation mode: ${mode}`,
    hasWeb
      ? "browser consultations: ENABLED by this explicit selection; real provider pages are automated headlessly and remain subject to account limits"
      : "browser consultations: off",
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
  const merged = applySetup(existing, { mode, planMode, reviewers, webOptIn: hasWeb });
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
