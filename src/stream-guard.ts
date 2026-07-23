/**
 * Generation-deadline enforcement for reviewer streams.
 *
 * A reachable endpoint is NOT proof a reviewer can generate: a wedged local
 * server (observed on vllm-mlx) answers `/v1/models` instantly, opens the SSE
 * stream, then never produces a token. This module classifies stream events
 * and enforces three independent deadlines:
 *
 * - connect:  time to the first stream event (≈ response headers)
 * - firstToken: time to the first MEANINGFUL token (real content or reasoning)
 * - total:    time to the terminal event
 *
 * Heartbeats, empty deltas, metadata-only chunks, and the SSE connection
 * itself never count as a meaningful first token.
 *
 * Transport-agnostic: providers feed it an event iterable; tests feed it
 * synthetic events. Cancellation always settles the underlying iterator so a
 * disconnected stream never stays registered as an active request.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";

/** Separate generation deadlines, all measured from call start. */
export interface StreamDeadlines {
  /** Max wait for the first stream event (connection/headers). */
  connectMs: number;
  /** Max wait for the first meaningful content/reasoning token. */
  firstTokenMs: number;
  /** Max wait for the whole generation. */
  totalMs: number;
}

export type FailureCategory =
  | "timeout_connect"
  | "timeout_first_token"
  | "timeout_total"
  | "transport"
  | "malformed_stream"
  | "empty_completion"
  | "aborted";

/** Categories that indicate the seat itself is unhealthy (circuit opens). */
export const CIRCUIT_OPENING_CATEGORIES: Readonly<Record<FailureCategory, boolean>> = {
  timeout_connect: true,
  timeout_first_token: true,
  timeout_total: true,
  transport: true,
  malformed_stream: true,
  empty_completion: true,
  aborted: false, // caller cancellation is not seat failure
};

export interface CallMetrics {
  /** First stream event (≈ headers) latency from call start. */
  connectLatencyMs?: number;
  /** First meaningful token latency from call start, when one arrived. */
  firstTokenLatencyMs?: number;
  /** Total latency from call start to terminal event or failure. */
  totalLatencyMs: number;
}

/** Typed reviewer-call failure; carries the category and partial metrics. */
export class ReviewerCallError extends Error {
  readonly category: FailureCategory;
  readonly metrics?: Partial<CallMetrics>;

  constructor(category: FailureCategory, message: string, metrics?: Partial<CallMetrics>) {
    super(message);
    this.name = "ReviewerCallError";
    this.category = category;
    this.metrics = metrics;
  }
}

/**
 * A meaningful token is real text or reasoning content. Heartbeats, empty or
 * whitespace-only deltas, stream start/end markers, and tool-call plumbing
 * do NOT count — a wedged server can emit all of those forever.
 */
export function isMeaningfulTokenEvent(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return typeof event.delta === "string" && event.delta.trim().length > 0;
    case "text_end":
    case "thinking_end":
      return typeof event.content === "string" && event.content.trim().length > 0;
    default:
      return false;
  }
}

export interface ConsumeStreamOptions {
  deadlines: StreamDeadlines;
  /** Caller cancellation; aborting it throws category "aborted" promptly. */
  signal?: AbortSignal;
  /**
   * Invoked exactly once before a deadline/transport failure is thrown, so
   * the caller can abort the underlying transport (close the SSE connection).
   */
  onAbortTransport?: (error: ReviewerCallError) => void;
  /** Clock injection for tests. */
  now?: () => number;
  /** Timer injection for tests; defaults to platform setTimeout. */
  startTimer?: (ms: number, fire: () => void) => DeadlineTimer;
}

export interface ConsumeStreamResult {
  message: AssistantMessage;
  metrics: CallMetrics;
}

function classifyStreamError(error: unknown): FailureCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (/json|parse|sse|malformed|unexpected token|invalid chunk/i.test(message)) return "malformed_stream";
  return "transport";
}

/** Named timer handle; hides the platform-specific timeout id type. */
export interface DeadlineTimer {
  cancel(): void;
}

function startDeadlineTimer(ms: number, fire: () => void): DeadlineTimer {
  const id = setTimeout(fire, ms);
  return { cancel: () => clearTimeout(id) };
}

/**
 * Consume an assistant-message event stream under generation deadlines.
 *
 * Resolves on the terminal "done" event. Throws ReviewerCallError on any
 * deadline, transport error, malformed stream, or caller abort. The iterator
 * is ALWAYS settled (`return()` in finally) so no generator is abandoned.
 */
export async function consumeAssistantStream(
  events: AsyncIterable<AssistantMessageEvent>,
  options: ConsumeStreamOptions,
): Promise<ConsumeStreamResult> {
  const now = options.now ?? Date.now;
  const startTimer = options.startTimer ?? startDeadlineTimer;
  const t0 = now();
  const { connectMs, firstTokenMs, totalMs } = options.deadlines;
  let connectAt: number | undefined;
  let firstTokenAt: number | undefined;

  const metrics = (): CallMetrics => ({
    connectLatencyMs: connectAt === undefined ? undefined : connectAt - t0,
    firstTokenLatencyMs: firstTokenAt === undefined ? undefined : firstTokenAt - t0,
    totalLatencyMs: now() - t0,
  });

  const fail = (category: FailureCategory, message: string): never => {
    const error = new ReviewerCallError(category, message, metrics());
    options.onAbortTransport?.(error);
    throw error;
  };

  const iterator = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (options.signal?.aborted) {
        fail("aborted", "review call cancelled by caller");
      }
      // Next applicable deadline: connect until first event, first-token until
      // a meaningful token, total always. All absolute from call start.
      let deadlineAt = t0 + totalMs;
      let category: FailureCategory = "timeout_total";
      if (connectAt === undefined && t0 + connectMs < deadlineAt) {
        deadlineAt = t0 + connectMs;
        category = "timeout_connect";
      }
      if (firstTokenAt === undefined && t0 + firstTokenMs < deadlineAt) {
        deadlineAt = t0 + firstTokenMs;
        category = "timeout_first_token";
      }
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        fail(category, timeoutMessage(category, options.deadlines));
      }

      const nextPromise = iterator.next();
      // Never leak an unhandled rejection if we abandon this read.
      const guarded = nextPromise.then(
        (result) => ({ kind: "next" as const, result }),
        (error) => ({ kind: "throw" as const, error }),
      );
      let timer: DeadlineTimer | undefined;
      const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = startTimer(remaining, () => resolve({ kind: "timeout" }));
      });
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<{ kind: "abort" }>((resolve) => {
        if (options.signal) {
          onAbort = () => resolve({ kind: "abort" });
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      const outcome = await Promise.race([guarded, timeoutPromise, abortPromise]);
      if (timer !== undefined) timer.cancel();
      if (onAbort && options.signal) options.signal.removeEventListener("abort", onAbort);

      if (outcome.kind === "timeout") {
        return fail(category, timeoutMessage(category, options.deadlines));
      }
      if (outcome.kind === "abort") {
        return fail("aborted", "review call cancelled by caller");
      }
      if (outcome.kind === "throw") {
        if (options.signal?.aborted) return fail("aborted", "review call cancelled by caller");
        const failureCategory = classifyStreamError(outcome.error);
        return fail(failureCategory, `review stream ${failureCategory === "malformed_stream" ? "malformed" : "failed"}: ${(outcome.error as Error)?.message ?? outcome.error}`);
      }

      const { result } = outcome;
      if (result.done) break; // iterable ended without a done event — fall through to message check below
      const event: AssistantMessageEvent = result.value;
      if (connectAt === undefined) connectAt = now();
      if (firstTokenAt === undefined && isMeaningfulTokenEvent(event)) firstTokenAt = now();

      if (event.type === "done") {
        const finalMetrics = metrics();
        // A generation that produced zero meaningful content is not healthy,
        // even when the transport closed cleanly (wedged-server signature).
        const produced = event.message.content.some(
          (block) =>
            (block.type === "text" && block.text.trim().length > 0) ||
            (block.type === "thinking" && block.thinking.trim().length > 0),
        );
        if (!produced && firstTokenAt === undefined) {
          fail("empty_completion", "review stream completed with zero meaningful content");
        }
        return { message: event.message, metrics: finalMetrics };
      }
      if (event.type === "error") {
        if (event.reason === "aborted" || options.signal?.aborted) {
          fail("aborted", "review call cancelled by caller");
        }
        const detail = event.error.errorMessage ?? "provider stream error";
        fail(classifyStreamError(new Error(detail)), `review stream error: ${detail}`);
      }
    }
    // Stream ended cleanly without a terminal event (server closed early).
    return fail("malformed_stream", "review stream ended without a terminal event");
  } finally {
    // Always settle the iterator: a disconnected/aborted stream must not
    // remain an active generator on the server side.
    try {
      await iterator.return?.(undefined as never);
    } catch {
      // Settling a broken iterator can throw; the transport is already dead.
    }
  }
}

function timeoutMessage(category: FailureCategory, deadlines: StreamDeadlines): string {
  switch (category) {
    case "timeout_connect":
      return `no stream event (headers) within ${Math.round(deadlines.connectMs / 1000)}s`;
    case "timeout_first_token":
      return `no meaningful token within ${Math.round(deadlines.firstTokenMs / 1000)}s — generation unresponsive`;
    default:
      return `generation exceeded total deadline of ${Math.round(deadlines.totalMs / 1000)}s`;
  }
}
