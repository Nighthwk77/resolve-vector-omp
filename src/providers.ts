/**
 * Reviewer transport adapters.
 *
 * Resolution goes through omp's own model registry (`ctx.models.resolve`,
 * `ctx.modelRegistry.getApiKey`) so reviewers use the same authenticated
 * providers the session already trusts. Calls are headless `stream()`
 * invocations — no windows, no focus, ever.
 *
 * Generation health is enforced HERE, on the real review call (never by a
 * pre-review health ping): every call runs under three deadlines — connect
 * (headers), first meaningful token, total — via consumeAssistantStream.
 * A wedged endpoint that answers `/v1/models` but never generates fails the
 * first-token deadline in ~10s (local default) instead of hanging the
 * council for the total timeout.
 *
 * Cancellation hygiene: caller aborts and deadline aborts both cancel the
 * provider transport AND settle the stream iterator, and every call is
 * unregistered from the active-request registry in `finally` — a
 * disconnected or aborted stream never stays registered as an active RV
 * request, and no generator is abandoned on the server side.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewerConfig } from "./policy.js";
import type { CallMetrics, StreamDeadlines } from "./stream-guard.js";
import { consumeAssistantStream, ReviewerCallError } from "./stream-guard.js";

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
  /** Connect/first-token/total latencies for receipts and health reporting. */
  metrics?: CallMetrics;
}

/** Per-call transport options. Deadlines/maxTokens come from council policy. */
export interface CompleteCallOptions {
  signal?: AbortSignal;
  deadlines?: StreamDeadlines;
  maxTokens?: number;
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

/* ─────────────────────── active-request registry ─────────────────────── */

export interface ActiveReviewerRequest {
  requestId: string;
  reviewerId: string;
  startedAt: number;
}

const activeRequests = new Map<string, ActiveReviewerRequest>();
let requestCounter = 0;

function registerActiveRequest(reviewerId: string): string {
  requestCounter += 1;
  const requestId = `rv-req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
  activeRequests.set(requestId, { requestId, reviewerId, startedAt: Date.now() });
  return requestId;
}

function unregisterActiveRequest(requestId: string): void {
  activeRequests.delete(requestId);
}

/** Live snapshot for `/rv status` and tests; empty when nothing is in flight. */
export function activeReviewerRequests(): ActiveReviewerRequest[] {
  return [...activeRequests.values()];
}

/* ────────────────────────── reviewer completion ────────────────────────── */

const DEFAULT_DEADLINES: StreamDeadlines = { connectMs: 10_000, firstTokenMs: 10_000, totalMs: 120_000 };
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Run one headless review call under generation deadlines.
 * Throws ReviewerCallError (typed category) on deadline, transport, or
 * provider error — never a bare timeout after 120s of silence.
 */
export async function runReviewerCompletion(
  resolved: ResolvedReviewer,
  systemPrompt: string,
  userPrompt: string,
  options?: CompleteCallOptions,
): Promise<ReviewerOutput> {
  const deadlines = options?.deadlines ?? DEFAULT_DEADLINES;
  // One controller per call: the caller's signal and the stream guard's
  // deadline aborts both cancel the provider transport (closing the SSE
  // connection) so nothing keeps generating after we stop listening.
  const controller = new AbortController();
  const caller = options?.signal;
  const onCallerAbort = () => controller.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) controller.abort(caller.reason);
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  const requestId = registerActiveRequest(resolved.config.id);
  try {
    // Lazy: pi-ai loads a native addon that only exists inside a live omp
    // process. Importing it here keeps providers.ts loadable in plain tests.
    const { stream } = await import("@oh-my-pi/pi-ai");
    const events = stream(
      resolved.model,
      {
        systemPrompt: [systemPrompt],
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      },
      {
        apiKey: resolved.apiKey,
        maxTokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: controller.signal,
      },
    );
    const { message, metrics } = await consumeAssistantStream(events, {
      deadlines,
      signal: caller,
      onAbortTransport: (error) => controller.abort(error),
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new ReviewerCallError(
        message.stopReason === "aborted" ? "aborted" : "transport",
        message.errorMessage ?? `review call ended with stopReason=${message.stopReason}`,
        metrics,
      );
    }
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    // Transport quirk seen on vllm-mlx: streamed replies carry the entire
    // answer in reasoning_content (→ thinking blocks) with empty content.
    // When that happens, review the thinking payload instead — the verdict
    // parser still decides whether it contains a valid JSON verdict.
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
      metrics,
    };
  } finally {
    if (caller) caller.removeEventListener("abort", onCallerAbort);
    // Idempotent: guarantees the transport is cancelled even when iteration
    // ended early; the guard already settled the iterator itself.
    controller.abort();
    unregisterActiveRequest(requestId);
  }
}
