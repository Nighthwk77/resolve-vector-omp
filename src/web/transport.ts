/**
 * Web-advisor transport: routes `web:<app>` council seats through the bridge
 * sidecar. Conservative by construction: master opt-in gate (off by
 * default), per-provider cooldown, concurrency 1, hard timeout, and no
 * retries of blocked/auth states (enforced bridge-side).
 */
import type { ResolvedReviewer, ReviewerOutput } from "../providers.js";
import type { CompleteCallOptions } from "../providers.js";
import type { ResolveVectorConfig } from "../policy.js";
import { WebBridgeManager } from "./manager.js";

export class WebConsultError extends Error {
  constructor(
    message: string,
    readonly category: string,
    readonly web: ReviewerOutput["web"],
  ) {
    super(message);
  }
}

export class WebTransport {
  private readonly manager: WebBridgeManager;
  private readonly lastConsultAt = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    agentDir: string,
    bridgeEntryPath: string,
    private readonly getConfig: () => ResolveVectorConfig,
    manager?: WebBridgeManager,
  ) {
    this.manager = manager ?? new WebBridgeManager(agentDir, bridgeEntryPath);
  }

  /** Exposed for /rv web commands. */
  get bridge(): WebBridgeManager {
    return this.manager;
  }

  /** CouncilDeps.complete for web seats; throws WebConsultError on failure. */
  complete = async (
    resolved: ResolvedReviewer,
    systemPrompt: string,
    userPrompt: string,
    options?: CompleteCallOptions,
  ): Promise<ReviewerOutput> => {
    const config = this.getConfig();
    if (!config.webAdvisors.optIn) {
      throw new WebConsultError("web advisors are disabled — opt in with /rv web on", "disabled", { failureCategory: "disabled" });
    }
    const app = resolved.config.provider.slice("web:".length);

    // Per-provider cooldown (account-risk throttle).
    const cooldown = Math.max(0, config.webAdvisors.cooldownMs);
    const sinceLast = Date.now() - (this.lastConsultAt.get(app) ?? 0);
    if (sinceLast < cooldown) {
      const waitMs = cooldown - sinceLast;
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, waitMs);
      options?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      await promise;
      if (options?.signal?.aborted) throw new WebConsultError("consultation cancelled", "cancelled", {});
    }

    // Concurrency 1 across ALL web consultations (single browser profile).
    const run = async (): Promise<ReviewerOutput> => {
      const result = await this.manager.consult(app, `${systemPrompt}\n\n${userPrompt}`, 120_000);
      this.lastConsultAt.set(app, Date.now());
      if (!result.ok) {
        throw new WebConsultError(result.error ?? "web consultation failed", result.category ?? "error", {
          sessionState: result.sessionState,
          popupClicks: result.popupClicks,
          retries: result.retries,
          failureCategory: result.category,
        });
      }
      return {
        text: result.text ?? "",
        usage: {},
        web: {
          sessionState: result.sessionState,
          popupClicks: result.popupClicks,
          retries: result.retries,
        },
      };
    };
    const outcome = this.queue.then(run, run);
    this.queue = outcome.catch(() => {});
    return outcome;
  };
}
