import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { probeReviewerGeneration, type ProbeComplete } from "../src/health.js";
import type { CompleteCallOptions, ResolvedReviewer } from "../src/providers.js";
import { consumeAssistantStream, type DeadlineTimer } from "../src/stream-guard.js";

/**
 * The probe's transport double: a `complete` that honors the passed deadlines
 * by running the REAL stream guard over a scripted event stream — so "the
 * endpoint hangs" is exercised through the same code path production uses.
 * Time is injected; nothing sleeps.
 */
let now = 1_000_000;

interface ScriptEntry {
  advanceMs?: number;
  event?: AssistantMessageEvent;
}

function messageWith(text: string): AssistantMessage {
  return { content: [{ type: "text", text }] } as unknown as AssistantMessage;
}

function fakeComplete(entries: readonly ScriptEntry[]): ProbeComplete {
  return (_resolved, _system, _user, options?: CompleteCallOptions) => {
    const deadlines = options?.deadlines ?? { connectMs: 1_000, firstTokenMs: 1_000, totalMs: 5_000 };
    // `parked` flips only when the guard is truly blocked on a wedged stream —
    // that is the one moment a platform clock would fire a deadline.
    const state = { parked: false };
    const iterable: AsyncIterable<AssistantMessageEvent> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next(): Promise<IteratorResult<AssistantMessageEvent>> {
            if (index < entries.length) {
              const entry = entries[index];
              index += 1;
              if (entry.advanceMs) now += entry.advanceMs;
              return Promise.resolve({ done: false, value: entry.event as AssistantMessageEvent });
            }
            state.parked = true;
            return new Promise(() => {}); // wedged after the script
          },
          return: () => Promise.resolve({ done: true, value: undefined }),
        };
      },
    };
    const timers: Array<{ ms: number; cancelled: boolean; fire(): void }> = [];
    const startTimer = (ms: number, fire: () => void): DeadlineTimer => {
      const timer = {
        ms,
        cancelled: false,
        fire: () => {
          if (!timer.cancelled) fire();
        },
      };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    };
    const consumed = consumeAssistantStream(iterable, { deadlines, now: () => now, startTimer });
    let settled = false;
    consumed.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return (async () => {
      for (let i = 0; i < 200 && !settled; i++) {
        await Promise.resolve();
        if (state.parked) timers.at(-1)?.fire();
      }
      const { message, metrics } = await consumed;
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { text, metrics };
    })();
  };
}

const resolvedDouble = {
  config: { id: "qwen", provider: "vllm-mlx", model: "qwen3", family: "qwen", role: "critic", local: true, enabled: true, order: 1 },
  model: { provider: "vllm-mlx", id: "qwen3" },
  family: "qwen",
} as unknown as ResolvedReviewer;

test("healthy generation: probe reports ok with connect/first-token/total latencies", async () => {
  const complete = fakeComplete([
    { event: { type: "start", partial: messageWith("") } },
    { advanceMs: 30, event: { type: "text_delta", contentIndex: 0, delta: "ok", partial: messageWith("ok") } },
    { advanceMs: 10, event: { type: "done", reason: "stop", message: messageWith("ok") } },
  ]);
  const probe = await probeReviewerGeneration(complete, resolvedDouble);
  assert.equal(probe.ok, true);
  assert.equal(probe.connectLatencyMs, 0);
  assert.equal(probe.firstTokenLatencyMs, 30);
  assert.equal(probe.totalLatencyMs, 40);
  assert.equal(probe.failureCategory, undefined);
});

test("endpoint answers but completion hangs (wedged vllm-mlx) → timeout_first_token, not ok", async () => {
  // /v1/models would return 200 here; generation produces nothing. The probe
  // deadline (tiny, strict) is what saves the user from a 120s wait.
  const complete = fakeComplete([{ event: { type: "start", partial: messageWith("") } }]);
  const probe = await probeReviewerGeneration(complete, resolvedDouble, { firstTokenMs: 200 });
  assert.equal(probe.ok, false);
  assert.equal(probe.failureCategory, "timeout_first_token");
  assert.match(probe.error ?? "", /no meaningful token/);
  assert.equal(probe.firstTokenLatencyMs, undefined);
  assert.ok(probe.connectLatencyMs !== undefined, "endpoint WAS reachable — generation was not");
});

test("zero-content completion → empty_completion, not healthy", async () => {
  const complete = fakeComplete([
    { event: { type: "start", partial: messageWith("") } },
    { advanceMs: 10, event: { type: "done", reason: "stop", message: messageWith("") } },
  ]);
  const probe = await probeReviewerGeneration(complete, resolvedDouble);
  assert.equal(probe.ok, false);
  assert.equal(probe.failureCategory, "empty_completion");
});

test("probe prompt is a fixed constant — no user content or secrets can leak into diagnostics", async () => {
  const seen: { system?: string; user?: string } = {};
  const complete: ProbeComplete = (_resolved, system, user) => {
    seen.system = system;
    seen.user = user;
    return Promise.resolve({ text: "ok", metrics: { totalLatencyMs: 1 } });
  };
  await probeReviewerGeneration(complete, resolvedDouble);
  assert.match(seen.system ?? "", /health probe/i);
  assert.match(seen.user ?? "", /^Reply with the single word/);
});

test("probe passes tiny output bounds and strict deadlines to transport", async () => {
  const seen: { options?: CompleteCallOptions } = {};
  const complete: ProbeComplete = (_resolved, _system, _user, options) => {
    seen.options = options;
    return Promise.resolve({ text: "ok", metrics: { totalLatencyMs: 1 } });
  };
  await probeReviewerGeneration(complete, resolvedDouble, { firstTokenMs: 123 });
  assert.ok(seen.options?.maxTokens !== undefined && seen.options.maxTokens <= 8, "4-8 output tokens max");
  assert.equal(seen.options?.deadlines?.firstTokenMs, 123);
});
