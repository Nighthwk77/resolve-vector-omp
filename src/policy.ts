/**
 * Modes, budgets, escalation, and privacy policy.
 *
 * Config lives at `<omp agent dir>/resolve-vector.json`. All fields optional;
 * defaults are conservative (manual mode, no external spend).
 */
import { open, readFile, appendFile, writeFile, stat, unlink } from "node:fs/promises";

export type ActivationMode = "off" | "manual" | "auto" | "always" | "sample";
export type CouncilMode = "review" | "best" | "fusion" | "compare";
export type ReviewerRole = "critic" | "verifier" | "method" | "judge" | "fusion";
export type ReviewerTrigger = "always" | "escalation" | "sample";

/** One council seat. `provider`/`model` resolve through omp's model registry. */
export interface ReviewerConfig {
  id: string;
  provider: string;
  model: string;
  /** Family label for diversity checks; verified live against ctx.models.family(). */
  family: string;
  role: ReviewerRole;
  local: boolean;
  enabled: boolean;
  order: number;
  trigger?: ReviewerTrigger;
}

export interface ResolveVectorConfig {
  mode: ActivationMode;
  defaultCouncilMode: CouncilMode;
  candidateCount: number;
  maxRevisionRounds: number;
  sampleRate: number;
  runInBackground: boolean;
  allowInteractiveWindows: boolean;
  maxExternalAuditsPerHour: number;
  maxExternalAuditsPerDay: number;
  maxConcurrentReviewers: number;
  reviewers: ReviewerConfig[];
}

export const DEFAULT_CONFIG: ResolveVectorConfig = {
  mode: "manual",
  defaultCouncilMode: "review",
  candidateCount: 3,
  maxRevisionRounds: 2,
  sampleRate: 0.1,
  runInBackground: true,
  allowInteractiveWindows: false,
  maxExternalAuditsPerHour: 10,
  maxExternalAuditsPerDay: 50,
  maxConcurrentReviewers: 2,
  reviewers: [],
};

const ACTIVATION_MODES: Record<ActivationMode, true> = { off: true, manual: true, auto: true, always: true, sample: true };
const COUNCIL_MODES: Record<CouncilMode, true> = { review: true, best: true, fusion: true, compare: true };
const REVIEWER_ROLES: Record<ReviewerRole, true> = { critic: true, verifier: true, method: true, judge: true, fusion: true };
const REVIEWER_TRIGGERS: Record<ReviewerTrigger, true> = { always: true, escalation: true, sample: true };

export interface ConfigLoadResult {
  config: ResolveVectorConfig;
  /** Actionable, user-facing problems. Empty means valid. */
  errors: string[];
  /** True when the file did not exist and defaults are in effect. */
  created: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReviewer(raw: unknown, index: number): { reviewer?: ReviewerConfig; errors: string[] } {
  const errors: string[] = [];
  const at = `reviewers[${index}]`;
  if (!isRecord(raw)) {
    return { errors: [`${at}: must be an object`] };
  }
  const str = (key: string): string | undefined => {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`${at}.${key}: required non-empty string`);
      return undefined;
    }
    return value;
  };
  const id = str("id");
  const provider = str("provider");
  const model = str("model");
  const family = str("family");
  const role = raw.role;
  if (typeof role !== "string" || !REVIEWER_ROLES[role as ReviewerRole]) {
    errors.push(`${at}.role: must be one of ${Object.keys(REVIEWER_ROLES).join(", ")}`);
  }
  if (typeof raw.local !== "boolean") errors.push(`${at}.local: must be boolean`);
  const order = typeof raw.order === "number" ? raw.order : index;
  const trigger = raw.trigger;
  if (trigger !== undefined && (typeof trigger !== "string" || !REVIEWER_TRIGGERS[trigger as ReviewerTrigger])) {
    errors.push(`${at}.trigger: must be one of ${Object.keys(REVIEWER_TRIGGERS).join(", ")}`);
  }
  if (errors.length > 0 || !id || !provider || !model || !family) return { errors };
  return {
    reviewer: {
      id,
      provider,
      model,
      family,
      role: role as ReviewerRole,
      local: raw.local as boolean,
      enabled: raw.enabled !== false,
      order,
      trigger: trigger as ReviewerTrigger | undefined,
    },
    errors: [],
  };
}

/** Validate raw JSON into a config, tolerating unknown/missing fields. */
export function parseConfig(raw: unknown): { config: ResolveVectorConfig; errors: string[] } {
  const errors: string[] = [];
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, reviewers: [] };
  if (raw === undefined || raw === null) return { config, errors };
  if (!isRecord(raw)) return { config, errors: ["config root: must be an object"] };

  if (raw.mode !== undefined) {
    if (typeof raw.mode === "string" && ACTIVATION_MODES[raw.mode as ActivationMode]) {
      config.mode = raw.mode as ActivationMode;
    } else {
      errors.push(`mode: must be one of ${Object.keys(ACTIVATION_MODES).join(", ")}`);
    }
  }
  if (raw.defaultCouncilMode !== undefined) {
    if (typeof raw.defaultCouncilMode === "string" && COUNCIL_MODES[raw.defaultCouncilMode as CouncilMode]) {
      config.defaultCouncilMode = raw.defaultCouncilMode as CouncilMode;
    } else {
      errors.push(`defaultCouncilMode: must be one of ${Object.keys(COUNCIL_MODES).join(", ")}`);
    }
  }
  type NumericKey =
    | "candidateCount"
    | "maxRevisionRounds"
    | "sampleRate"
    | "maxExternalAuditsPerHour"
    | "maxExternalAuditsPerDay"
    | "maxConcurrentReviewers";
  const num = (key: NumericKey, min: number, max: number): void => {
    const value = raw[key];
    if (value === undefined) return;
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
      config[key] = value;
    } else {
      errors.push(`${key}: must be a number in [${min}, ${max}]`);
    }
  };
  num("candidateCount", 2, 8);
  num("maxRevisionRounds", 0, 5);
  num("sampleRate", 0, 1);
  num("maxExternalAuditsPerHour", 0, 1000);
  num("maxExternalAuditsPerDay", 0, 10000);
  num("maxConcurrentReviewers", 1, 8);
  const bool = (key: "runInBackground" | "allowInteractiveWindows"): void => {
    const value = raw[key];
    if (value === undefined) return;
    if (typeof value === "boolean") {
      config[key] = value;
    } else {
      errors.push(`${key}: must be boolean`);
    }
  };
  bool("runInBackground");
  bool("allowInteractiveWindows");

  if (raw.reviewers !== undefined) {
    if (!Array.isArray(raw.reviewers)) {
      errors.push("reviewers: must be an array");
    } else {
      raw.reviewers.forEach((entry, index) => {
        const { reviewer, errors: reviewerErrors } = validateReviewer(entry, index);
        errors.push(...reviewerErrors);
        if (reviewer) config.reviewers.push(reviewer);
      });
      const ids = new Set<string>();
      for (const reviewer of config.reviewers) {
        if (ids.has(reviewer.id)) errors.push(`reviewers: duplicate id "${reviewer.id}"`);
        ids.add(reviewer.id);
      }
      config.reviewers.sort((a, b) => a.order - b.order);
    }
  }
  return { config, errors };
}

/** Load and validate the config file. Missing file → defaults, not an error. */
export async function loadConfig(path: string): Promise<ConfigLoadResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG, reviewers: [] }, errors: [], created: true };
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG, reviewers: [] },
      errors: [`${path}: invalid JSON — ${(error as Error).message}`],
      created: false,
    };
  }
  const { config, errors } = parseConfig(raw);
  return { config, errors, created: false };
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Enforce hourly/daily external-call budgets. `externalTimestamps` are epoch ms
 * of past external reviewer calls (from receipts). Local reviewers are always allowed.
 */
export function checkExternalBudget(
  config: ResolveVectorConfig,
  externalTimestamps: readonly number[],
  now: number,
): BudgetDecision {
  const hourAgo = now - 3_600_000;
  const dayAgo = now - 86_400_000;
  const inHour = externalTimestamps.filter((t) => t >= hourAgo).length;
  if (inHour >= config.maxExternalAuditsPerHour) {
    return {
      allowed: false,
      reason: `external budget reached: ${inHour}/${config.maxExternalAuditsPerHour} calls in the last hour`,
    };
  }
  const inDay = externalTimestamps.filter((t) => t >= dayAgo).length;
  if (inDay >= config.maxExternalAuditsPerDay) {
    return {
      allowed: false,
      reason: `external budget reached: ${inDay}/${config.maxExternalAuditsPerDay} calls in the last day`,
    };
  }
  return { allowed: true };
}

/**
 * Shared budget coordinator contract. tryReserve is check+record as one
 * atomic step; implementations may be sync (in-memory) or async (ledger).
 */
export interface BudgetCoordinator {
  tryReserve(now: number): BudgetDecision | Promise<BudgetDecision>;
}

/**
 * In-memory budget reservations for a single process. A reservation is
 * check+record in one synchronous step. Reservations count ATTEMPTS: the
 * timestamp is recorded before dispatch and kept even when the call fails,
 * because the external provider saw the traffic either way (ban-safety, per
 * the legacy DeepSeek suspension).
 */
export class ExternalBudgetTracker implements BudgetCoordinator {
  private readonly timestamps: number[];

  constructor(
    private readonly config: ResolveVectorConfig,
    initialTimestamps: readonly number[],
    private readonly onReserve?: (timestamp: number) => void,
  ) {
    this.timestamps = [...initialTimestamps];
  }

  /** Reserve one external call. Allowed → recorded atomically and reported. */
  tryReserve(now: number): BudgetDecision {
    const decision = checkExternalBudget(this.config, this.timestamps, now);
    if (decision.allowed) {
      this.timestamps.push(now);
      this.onReserve?.(now);
    }
    return decision;
  }
}

interface LedgerEntry {
  id: string;
  at: number;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

/**
 * Cross-process budget ledger. The ledger file is the single source of truth
 * for external-call budgets: every attempt is appended BEFORE dispatch, so
 * traffic counts even when the caller crashes or the audit receipt never
 * lands. Atomicity comes from two layers: an in-process promise mutex, and a
 * lockfile (`wx` create) for the many-omp-processes case, with stale-lock
 * recovery keyed on mtime. First run bootstraps from historical receipts so
 * pre-ledger traffic inside the budget windows still counts.
 */
export class FileBudgetLedger implements BudgetCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private counter = 0;
  /** Owner token of the lock this instance currently holds, if any. */
  private lockToken?: string;

  constructor(
    private readonly config: ResolveVectorConfig,
    private readonly ledgerPath: string,
    private readonly seedFromReceipts?: () => Promise<number[]>,
  ) {}

  tryReserve(now: number): Promise<BudgetDecision> {
    const result = this.tail.then(() => this.reserveUnlocked(now));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async reserveUnlocked(now: number): Promise<BudgetDecision> {
    await this.acquireLock();
    try {
      const entries = await this.readEntries();
      const decision = checkExternalBudget(
        this.config,
        entries.map((e) => e.at),
        now,
      );
      if (!decision.allowed) return decision;
      this.counter += 1;
      const entry: LedgerEntry = {
        id: `res-${now.toString(36)}-${process.pid.toString(36)}-${this.counter.toString(36)}`,
        at: now,
      };
      await appendFile(this.ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
      return { allowed: true };
    } finally {
      await this.releaseLock();
    }
  }

  /** Ledger contents; bootstraps from receipts exactly once (file creation is the marker). */
  private async readEntries(): Promise<LedgerEntry[]> {
    let text: string;
    try {
      text = await readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const seeds = ((await this.seedFromReceipts?.()) ?? []).map((at, index) => ({
        id: `seed-${index}-${at}`,
        at,
      }));
      const body = seeds.length > 0 ? `${seeds.map((s) => JSON.stringify(s)).join("\n")}\n` : "";
      await writeFile(this.ledgerPath, body, "utf8");
      return seeds;
    }
    const entries: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as LedgerEntry;
        if (typeof parsed.at === "number") entries.push(parsed);
      } catch {
        // Corrupt line: skip — never let a damaged ledger block reviews.
      }
    }
    return entries;
  }

  private async acquireLock(): Promise<void> {
    const lockPath = `${this.ledgerPath}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        this.counter += 1;
        const token = `lock-${Date.now().toString(36)}-${process.pid.toString(36)}-${this.counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        const handle = await open(lockPath, "wx");
        await handle.writeFile(token);
        await handle.close();
        this.lockToken = token;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        } catch {
          continue; // lock vanished between checks — retry immediately
        }
        if (Date.now() > deadline) throw new Error("budget ledger lock timeout");
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 20 + Math.random() * 40);
        await promise;
      }
    }
  }

  /**
   * Release only a lock we still own. A stale-stolen lock may have been
   * replaced by another owner's; removing THAT would let a third process
   * into the critical section, so the token must match before unlinking.
   */
  private async releaseLock(): Promise<void> {
    const token = this.lockToken;
    this.lockToken = undefined;
    if (!token) return;
    const lockPath = `${this.ledgerPath}.lock`;
    let current: string;
    try {
      current = await readFile(lockPath, "utf8");
    } catch {
      return; // already gone (stolen and not yet replaced, or cleaned up)
    }
    if (current === token) await unlink(lockPath).catch(() => {});
  }
}
