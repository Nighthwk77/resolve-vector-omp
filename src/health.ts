/**
 * Tiny generation probe for `/rv status`, `/rv doctor`, and setup validation.
 *
 * `endpoint reachable` (TCP/HTTP, `/v1/models`) only proves a server answers
 * HTTP — a wedged vllm-mlx does that while being unable to generate. The
 * probe proves `generation healthy`: a minimal prompt, a handful of output
 * tokens, no tools, and a strict first-meaningful-token deadline.
 *
 * Probe prompts are fixed constants — no user content, no secrets, nothing
 * private ever appears in health diagnostics.
 */
import type { CompleteCallOptions, ResolvedReviewer } from "./providers.js";
import { ReviewerCallError, type CallMetrics, type FailureCategory } from "./stream-guard.js";

/** Transport function shape the probe needs (CouncilDeps["complete"]). */
export type ProbeComplete = (
  resolved: ResolvedReviewer,
  systemPrompt: string,
  userPrompt: string,
  options?: CompleteCallOptions,
) => Promise<{ text: string; metrics?: CallMetrics }>;

const PROBE_SYSTEM_PROMPT = "You are a health probe. Reply with the single word: ok";
const PROBE_USER_PROMPT = "Reply with the single word: ok";
const PROBE_MAX_TOKENS = 6;

export interface GenerationProbe {
  /** True only when a meaningful completion actually arrived in time. */
  ok: boolean;
  connectLatencyMs?: number;
  firstTokenLatencyMs?: number;
  totalLatencyMs?: number;
  failureCategory?: FailureCategory;
  error?: string;
}

export interface ProbeOptions {
  /** Strict first-meaningful-token deadline; defaults to 10s. */
  firstTokenMs?: number;
  /** Connect/headers deadline; defaults to 5s (tight, local-first). */
  connectMs?: number;
  /** Total probe deadline; defaults to 45s. */
  totalMs?: number;
  signal?: AbortSignal;
}

/**
 * Run one tiny generation against a resolved reviewer. Never throws; the
 * result distinguishes transport reachability from generation health via
 * latencies and failure category.
 */
export async function probeReviewerGeneration(
  complete: ProbeComplete,
  resolved: ResolvedReviewer,
  options?: ProbeOptions,
): Promise<GenerationProbe> {
  try {
    const output = await complete(resolved, PROBE_SYSTEM_PROMPT, PROBE_USER_PROMPT, {
      signal: options?.signal,
      maxTokens: PROBE_MAX_TOKENS,
      deadlines: {
        connectMs: options?.connectMs ?? 5_000,
        firstTokenMs: options?.firstTokenMs ?? 10_000,
        totalMs: options?.totalMs ?? 45_000,
      },
    });
    const metrics = output.metrics;
    if (output.text.trim().length === 0) {
      return {
        ok: false,
        connectLatencyMs: metrics?.connectLatencyMs,
        firstTokenLatencyMs: metrics?.firstTokenLatencyMs,
        totalLatencyMs: metrics?.totalLatencyMs,
        failureCategory: "empty_completion",
        error: "probe completed with zero meaningful content",
      };
    }
    return {
      ok: true,
      connectLatencyMs: metrics?.connectLatencyMs,
      firstTokenLatencyMs: metrics?.firstTokenLatencyMs,
      totalLatencyMs: metrics?.totalLatencyMs,
    };
  } catch (error) {
    if (error instanceof ReviewerCallError) {
      return {
        ok: false,
        connectLatencyMs: error.metrics?.connectLatencyMs,
        firstTokenLatencyMs: error.metrics?.firstTokenLatencyMs,
        totalLatencyMs: error.metrics?.totalLatencyMs,
        failureCategory: error.category,
        error: error.message,
      };
    }
    return { ok: false, failureCategory: "transport", error: (error as Error).message };
  }
}
