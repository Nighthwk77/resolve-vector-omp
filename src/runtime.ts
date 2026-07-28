/**
 * Runtime wiring: owns the loaded config, receipt persistence, and the
 * omp-context-bound council dependencies. Commands, the model-callable tool,
 * and (later) agent_end activation all go through this one object so every
 * entry point runs the same engine and writes the same receipts.
 *
 * The external-call budget lives in ONE FileBudgetLedger per runtime, shared
 * by every runReview call and guarded cross-process by a lockfile. A
 * reservation lands in the ledger before dispatch, so attempts count even if
 * the review crashes or the receipt never persists.
 */
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import type { CouncilDeps, CouncilProgressEvent } from "./council.js";
import { runCouncil, runEnsemble } from "./council.js";
import {
  FileBudgetLedger,
  loadConfig,
  reviewerAppliesTo,
  type ActivationMode,
  type BudgetCoordinator,
  type ResolveVectorConfig,
  type ReviewerConfig,
  type ReviewerWorkflow,
} from "./policy.js";
import { isWebSeat, resolveReviewer, runReviewerCompletion } from "./providers.js";
import { WebTransport } from "./web/transport.js";
import {
  appendReceipt,
  externalCallUnits,
  readReceipts,
  type CouncilVerdict,
  type EvidenceItem,
  type ReviewReceipt,
} from "./receipts.js";

export interface RuntimePaths {
  configPath: string;
  receiptsPath: string;
  ledgerPath: string;
  /** Agent dir for bridge state/profile files. */
  agentDir: string;
}

export function defaultPaths(agentDir: string): RuntimePaths {
  return {
    // RV_CONFIG_PATH: isolated-test override — point one OMP session at an
    // alternate reviewer config without touching the live installation.
    configPath: process.env.RV_CONFIG_PATH ?? join(agentDir, "resolve-vector.json"),
    receiptsPath: join(agentDir, "resolve-vector.receipts.jsonl"),
    ledgerPath: join(agentDir, "resolve-vector.budget.jsonl"),
    agentDir,
  };
}

export interface RunReviewRequest {
  goal: string;
  proposal: string;
  evidence?: EvidenceItem[];
  constraints?: string[];
  primaryFamily?: string;
  activationReason: ReviewReceipt["activationReason"];
  activationDetail?: string;
  revisionRound?: number;
  workflow?: ReviewReceipt["workflow"];
  planReview?: ReviewReceipt["planReview"];
  /** Visible progress (reviewing with… / unavailable — continuing with…). */
  onProgress?: (event: CouncilProgressEvent) => void;
}

export interface RunEnsembleRequest {
  mode: "best" | "fusion" | "compare";
  goal: string;
  constraints?: string[];
  evidence?: EvidenceItem[];
  candidateCount?: number;
  primaryFamily?: string;
  activationReason: ReviewReceipt["activationReason"];
}

/**
 * The surface commands and tools depend on. RVRuntime implements it; tests
 * substitute plain fakes without importing the provider stack (which loads
 * native addons only present inside a live omp process).
 */
export interface RVEngine {
  readonly paths: RuntimePaths;
  readonly config: ResolveVectorConfig;
  /** Per-reviewer circuit breaker; shared by reviews, doctor, and /rv status. */
  readonly circuits: CircuitBreakerRegistry;
  /** Transport seam (headless pi-ai by default); used by council and health probes. */
  readonly complete: CouncilDeps["complete"];
  /** Web-advisor transport (bridge lifecycle + consultations). */
  readonly web: WebTransport;
  configErrors: string[];
  configCreated: boolean;
  setMode(mode: ActivationMode): void;
  runReview(ctx: ExtensionContext, request: RunReviewRequest, signal?: AbortSignal): Promise<CouncilVerdict>;
  runEnsemble(ctx: ExtensionContext, request: RunEnsembleRequest, signal?: AbortSignal): Promise<CouncilVerdict>;
  recentReceipts(limit: number): Promise<ReviewReceipt[]>;
  /** Re-read config from disk and rebuild dependent state (used by /rv setup). */
  reload(): Promise<void>;
}

export interface RuntimeOptions {
  /** DI seam: transport for reviewer calls. Defaults to the headless pi-ai path. */
  complete?: CouncilDeps["complete"];
  /** DI seam: budget coordinator. Defaults to the shared file ledger. */
  budget?: BudgetCoordinator;
}

/** Ensembles need independent solvers, so include the active OMP model as one seat. */
export function ensembleReviewers(
  ctx: ExtensionContext,
  configured: readonly ReviewerConfig[],
): ReviewerConfig[] {
  const reviewers = [...configured];
  const model = ctx.model;
  if (!model) return reviewers;
  if (reviewers.some((reviewer) => reviewer.provider === model.provider && reviewer.model === model.id)) {
    return reviewers;
  }
  const local = /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(model.baseUrl ?? "");
  reviewers.unshift({
    id: "omp-primary",
    provider: model.provider,
    model: model.id,
    family: ctx.models.family(model),
    role: "critic",
    local,
    enabled: true,
    order: 0,
    scope: local ? "local-only" : "external-redacted",
    workflows: ["completion_review"],
  });
  return reviewers;
}

export class RVRuntime implements RVEngine {
  private budget: BudgetCoordinator;
  readonly complete: CouncilDeps["complete"];
  readonly circuits: CircuitBreakerRegistry;
  /** Web-advisor transport (bridge lifecycle + consultations). */
  readonly web: WebTransport;

  private constructor(
    public readonly paths: RuntimePaths,
    public config: ResolveVectorConfig,
    public configErrors: string[],
    public configCreated: boolean,
    options: RuntimeOptions = {},
  ) {
    this.web = new WebTransport(paths.agentDir, new URL("./web/bridge-entry.mjs", import.meta.url).pathname, () => this.config);
    this.complete =
      options.complete ??
      ((resolved, systemPrompt, userPrompt, callOptions) =>
        isWebSeat(resolved.config)
          ? this.web.complete(resolved, systemPrompt, userPrompt, callOptions)
          : runReviewerCompletion(resolved, systemPrompt, userPrompt, callOptions));
    this.circuits = new CircuitBreakerRegistry({ cooldownMs: config.circuitBreakerCooldownMs });
    this.budget =
      options.budget ??
      new FileBudgetLedger(config, paths.ledgerPath, async () => {
        // Bootstrap must never block reviews: unreadable receipts seed as empty.
        return externalCallUnits(await readReceipts(paths.receiptsPath).catch(() => []));
      });
  }

  static async load(paths: RuntimePaths, options: RuntimeOptions = {}): Promise<RVRuntime> {
    const { config, errors, created } = await loadConfig(paths.configPath);
    return new RVRuntime(paths, config, errors, created, options);
  }

  /** Session-scoped mode change. Persisting to disk is a deliberate non-goal for M1. */
  setMode(mode: ActivationMode): void {
    this.config = { ...this.config, mode };
  }

  /** Re-read config from disk; rebuild the budget ledger (caps may have changed). */
  async reload(): Promise<void> {
    const { config, errors, created } = await loadConfig(this.paths.configPath);
    this.config = config;
    this.configErrors = errors;
    this.configCreated = created;
    // Circuit state survives reload (a dead seat stays skipped); the cooldown retunes.
    this.circuits.cooldownMs = config.circuitBreakerCooldownMs;
    this.budget = new FileBudgetLedger(config, this.paths.ledgerPath, async () => {
      return externalCallUnits(await readReceipts(this.paths.receiptsPath).catch(() => []));
    });
  }

  async runReview(ctx: ExtensionContext, request: RunReviewRequest, signal?: AbortSignal): Promise<CouncilVerdict> {
    const workflow: ReviewerWorkflow = request.workflow ?? "completion_review";
    const workflowConfig = {
      ...this.config,
      reviewers: this.config.reviewers.filter((reviewer) => reviewerAppliesTo(reviewer, workflow)),
    };
    const verdict = await runCouncil({
      goal: request.goal,
      proposal: request.proposal,
      evidence: request.evidence,
      constraints: request.constraints,
      primaryFamily: request.primaryFamily,
      config: workflowConfig,
      deps: {
        resolveReviewer: (reviewer) => resolveReviewer(ctx, reviewer),
        complete: this.complete,
        budget: this.budget,
        signal,
        circuit: this.circuits,
        onProgress: request.onProgress,
      },
    });
    const receipt: ReviewReceipt = {
      receiptId: verdict.id,
      workflow,
      activationReason: request.activationReason,
      activationDetail: request.activationDetail,
      revisionRound: request.revisionRound ?? 0,
      primaryFamily: request.primaryFamily,
      verdict,
      planReview: request.planReview,
    };
    await appendReceipt(this.paths.receiptsPath, receipt);
    return verdict;
  }

  async recentReceipts(limit: number): Promise<ReviewReceipt[]> {
    const receipts = await readReceipts(this.paths.receiptsPath);
    return receipts.slice(-limit);
  }

  async runEnsemble(ctx: ExtensionContext, request: RunEnsembleRequest, signal?: AbortSignal): Promise<CouncilVerdict> {
    const configured = this.config.reviewers.filter((reviewer) => reviewerAppliesTo(reviewer, "completion_review"));
    const workflowConfig = {
      ...this.config,
      reviewers: ensembleReviewers(ctx, configured),
    };
    const verdict = await runEnsemble({
      mode: request.mode,
      goal: request.goal,
      constraints: request.constraints,
      evidence: request.evidence,
      candidateCount: request.candidateCount ?? this.config.candidateCount,
      // Unlike review mode, ensembles intentionally include the primary as an
      // independent candidate generator. Identity is stripped before judging.
      primaryFamily: undefined,
      config: workflowConfig,
      deps: {
        resolveReviewer: (reviewer) => resolveReviewer(ctx, reviewer),
        complete: this.complete,
        budget: this.budget,
        signal,
        circuit: this.circuits,
      },
    });
    await appendReceipt(this.paths.receiptsPath, {
      receiptId: verdict.id,
      activationReason: request.activationReason,
      revisionRound: 0,
      primaryFamily: request.primaryFamily,
      verdict,
    });
    return verdict;
  }
}
