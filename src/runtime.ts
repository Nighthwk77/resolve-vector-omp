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
import type { CouncilDeps } from "./council.js";
import { runCouncil } from "./council.js";
import { FileBudgetLedger, loadConfig, type ActivationMode, type BudgetCoordinator, type ResolveVectorConfig } from "./policy.js";
import { resolveReviewer, runReviewerCompletion } from "./providers.js";
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
}

export function defaultPaths(agentDir: string): RuntimePaths {
  return {
    configPath: join(agentDir, "resolve-vector.json"),
    receiptsPath: join(agentDir, "resolve-vector.receipts.jsonl"),
    ledgerPath: join(agentDir, "resolve-vector.budget.jsonl"),
  };
}

export interface RunReviewRequest {
  goal: string;
  proposal: string;
  evidence?: EvidenceItem[];
  constraints?: string[];
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
  readonly configErrors: string[];
  readonly configCreated: boolean;
  setMode(mode: ActivationMode): void;
  runReview(ctx: ExtensionContext, request: RunReviewRequest, signal?: AbortSignal): Promise<CouncilVerdict>;
  recentReceipts(limit: number): Promise<ReviewReceipt[]>;
}

export interface RuntimeOptions {
  /** DI seam: transport for reviewer calls. Defaults to the headless pi-ai path. */
  complete?: CouncilDeps["complete"];
  /** DI seam: budget coordinator. Defaults to the shared file ledger. */
  budget?: BudgetCoordinator;
}

export class RVRuntime implements RVEngine {
  private readonly budget: RuntimeOptions["budget"];
  private readonly complete: CouncilDeps["complete"];

  private constructor(
    public readonly paths: RuntimePaths,
    public config: ResolveVectorConfig,
    public readonly configErrors: string[],
    public readonly configCreated: boolean,
    options: RuntimeOptions = {},
  ) {
    this.complete =
      options.complete ??
      ((resolved, systemPrompt, userPrompt, signal) =>
        runReviewerCompletion(resolved, systemPrompt, userPrompt, { signal }));
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

  async runReview(ctx: ExtensionContext, request: RunReviewRequest, signal?: AbortSignal): Promise<CouncilVerdict> {
    const verdict = await runCouncil({
      goal: request.goal,
      proposal: request.proposal,
      evidence: request.evidence,
      constraints: request.constraints,
      primaryFamily: request.primaryFamily,
      config: this.config,
      deps: {
        resolveReviewer: (reviewer) => resolveReviewer(ctx, reviewer),
        complete: this.complete,
        budget: this.budget,
        signal,
      },
    });
    const receipt: ReviewReceipt = {
      receiptId: verdict.id,
      activationReason: request.activationReason,
      revisionRound: 0,
      primaryFamily: request.primaryFamily,
      verdict,
    };
    await appendReceipt(this.paths.receiptsPath, receipt);
    return verdict;
  }

  async recentReceipts(limit: number): Promise<ReviewReceipt[]> {
    const receipts = await readReceipts(this.paths.receiptsPath);
    return receipts.slice(-limit);
  }
}
