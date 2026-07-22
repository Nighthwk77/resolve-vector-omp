/**
 * Reviewer transport adapters.
 *
 * Resolution goes through omp's own model registry (`ctx.models.resolve`,
 * `ctx.modelRegistry.getApiKey`) so reviewers use the same authenticated
 * providers the session already trusts. Calls are headless `complete()`
 * invocations — no windows, no focus, ever.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewerConfig } from "./policy.js";

export interface ResolvedReviewer {
  config: ReviewerConfig;
  model: Model;
  /** Live family token from the catalog — the diversity check's ground truth. */
  family: string;
  apiKey?: string;
}

export interface ReviewerOutput {
  text: string;
  usage?: { input?: number; output?: number };
}

export type ResolveError = "unknown_model" | "no_api_key";

export type ResolveResult =
  | { ok: true; reviewer: ResolvedReviewer }
  | { ok: false; error: ResolveError; detail: string };

/** Resolve a configured reviewer to an authenticated omp model. */
export async function resolveReviewer(ctx: ExtensionContext, config: ReviewerConfig): Promise<ResolveResult> {
  const model = ctx.models.resolve(`${config.provider}/${config.model}`) ?? ctx.models.resolve(config.model);
  if (!model) {
    return { ok: false, error: "unknown_model", detail: `${config.provider}/${config.model} is not an authenticated model in this session` };
  }
  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey && !config.local) {
    return { ok: false, error: "no_api_key", detail: `no credential available for ${config.provider}/${config.model}` };
  }
  return { ok: true, reviewer: { config, model, family: ctx.models.family(model), apiKey } };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;

/** Run one headless review call. Throws on transport error or provider error. */
export async function runReviewerCompletion(
  resolved: ResolvedReviewer,
  systemPrompt: string,
  userPrompt: string,
  options?: { timeoutMs?: number; maxTokens?: number; signal?: AbortSignal },
): Promise<ReviewerOutput> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  // Lazy: pi-ai loads a native addon that only exists inside a live omp
  // process. Importing it here keeps providers.ts loadable in plain tests.
  const { complete } = await import("@oh-my-pi/pi-ai");
  const message = await complete(
    resolved.model,
    {
      systemPrompt: [systemPrompt],
      messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
    },
    {
      apiKey: resolved.apiKey,
      maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      signal,
    },
  );
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? `review call ended with stopReason=${message.stopReason}`);
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  // Transport quirk seen on vllm-mlx: streamed replies carry the entire answer
  // in reasoning_content (→ thinking blocks) with empty content. When that
  // happens, review the thinking payload instead — the verdict parser still
  // decides whether it contains a valid JSON verdict.
  const effectiveText =
    text.trim().length > 0
      ? text
      : message.content
          .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
          .map((block) => block.thinking)
          .join("");
  return {
    text: effectiveText,
    usage: { input: message.usage.input, output: message.usage.output },
  };
}
