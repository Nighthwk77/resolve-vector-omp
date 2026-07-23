import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import {
  consumeAssistantStream,
  type DeadlineTimer,
  isMeaningfulTokenEvent,
  ReviewerCallError,
  type StreamDeadlines,
} from "../src/stream-guard.js";

/**
 * Deterministic time: the guard's clock and deadline timers are injected, so
 * tests advance time explicitly instead of sleeping. `now` only moves when a
 * scripted event says so (`advanceMs`).
 */
let now = 1_000_000;

interface ManualTimer {
  ms: number;
  cancelled: boolean;
  fire(): void;
}

function manualTimers() {
  const timers: ManualTimer[] = [];
  const startTimer = (ms: number, fire: () => void): DeadlineTimer => {
    const timer: ManualTimer = {
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
  return { timers, startTimer };
}

/** Minimal assistant message double; the guard only reads .content. */
function messageWith(text: string, thinking = ""): AssistantMessage {
  const content = [];
  if (thinking.length > 0) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text });
  return { content } as unknown as AssistantMessage;
}

function startEvent(): AssistantMessageEvent {
  return { type: "start", partial: messageWith("") };
}

function doneEvent(text: string, thinking = ""): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: messageWith(text, thinking) };
}

interface ScriptEntry {
  advanceMs?: number;
  event?: AssistantMessageEvent;
  throwError?: Error;
}

/**
 * Scripted stream as a plain iterator: yields the script, then pends forever.
 * `return()` ALWAYS settles immediately — mirroring pi-ai's EventStream,
 * whose pending reads resolve when the transport is aborted. (`returned` is
 * the observable proof that nobody abandoned the stream.)
 */
function scriptedIterable(entries: readonly ScriptEntry[]): AsyncIterable<AssistantMessageEvent> & { readonly returned: boolean } {
  const state = { returned: false };
  return {
    get returned() {
      return state.returned;
    },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<AssistantMessageEvent>> {
          if (state.returned) return Promise.resolve({ done: true, value: undefined });
          if (index < entries.length) {
            const entry = entries[index];
            index += 1;
            if (entry.advanceMs) now += entry.advanceMs;
            if (entry.throwError) return Promise.reject(entry.throwError);
            return Promise.resolve({ done: false, value: entry.event as AssistantMessageEvent });
          }
          return new Promise(() => {}); // wedged: never yields again
        },
        return(): Promise<IteratorResult<AssistantMessageEvent>> {
          state.returned = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/** Flush microtasks until `cond` holds (scripted streams settle in microtasks only). */
async function flushUntil(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await Promise.resolve();
  assert.ok(cond(), `stream did not reach expected state: ${what}`);
}

const FAST: StreamDeadlines = { connectMs: 120, firstTokenMs: 200, totalMs: 600 };

interface RunOptions {
  deadlines?: StreamDeadlines;
  signal?: AbortSignal;
  onAbortTransport?: (error: ReviewerCallError) => void;
}

interface RunHandle {
  timers: ManualTimer[];
  /** Fire the most recently armed deadline. */
  fireLatest(): void;
  result: ReturnType<typeof consumeAssistantStream>;
}

function runGuard(events: AsyncIterable<AssistantMessageEvent>, options: RunOptions = {}): RunHandle {
  const { timers, startTimer } = manualTimers();
  const result = consumeAssistantStream(events, {
    deadlines: options.deadlines ?? FAST,
    signal: options.signal,
    onAbortTransport: options.onAbortTransport,
    now: () => now,
    startTimer,
  });
  return { timers, fireLatest: () => timers.at(-1)?.fire(), result };
}

async function expectCategory(result: Promise<unknown>, category: string): Promise<ReviewerCallError> {
  try {
    await result;
  } catch (error) {
    assert.ok(error instanceof ReviewerCallError, `expected ReviewerCallError, got ${error}`);
    assert.equal((error as ReviewerCallError).category, category);
    return error as ReviewerCallError;
  }
  assert.fail(`expected the stream to fail with ${category}`);
}

test("isMeaningfulTokenEvent: only real content or reasoning counts", () => {
  assert.equal(isMeaningfulTokenEvent({ type: "text_delta", contentIndex: 0, delta: "Hello", partial: messageWith("H") }), true);
  assert.equal(isMeaningfulTokenEvent({ type: "thinking_delta", contentIndex: 0, delta: "reasoning…", partial: messageWith("") }), true);
  assert.equal(isMeaningfulTokenEvent({ type: "text_delta", contentIndex: 0, delta: "", partial: messageWith("") }), false);
  assert.equal(isMeaningfulTokenEvent({ type: "text_delta", contentIndex: 0, delta: "   \n ", partial: messageWith("") }), false);
  assert.equal(isMeaningfulTokenEvent(startEvent()), false);
});

test("headers arrive but no content token ever arrives → timeout_first_token at the FIRST-TOKEN deadline", async () => {
  const stream = scriptedIterable([{ event: startEvent() }]);
  const run = runGuard(stream);
  await flushUntil(() => run.timers.length >= 2, "start consumed, post-connect deadline armed");
  run.fireLatest();
  const error = await expectCategory(run.result, "timeout_first_token");
  assert.ok(error.metrics?.connectLatencyMs !== undefined, "connect latency recorded");
  assert.equal(error.metrics?.firstTokenLatencyMs, undefined, "no first token ever arrived");
  // The deadline that fired was the first-token budget, NOT the 120s-style total.
  assert.equal(run.timers.at(-1)?.ms, FAST.firstTokenMs);
  assert.ok(FAST.firstTokenMs < FAST.totalMs);
  assert.equal(stream.returned, true, "stream settled after abort");
});

test("heartbeat-only stream (SSE alive, zero events) → timeout_first_token", async () => {
  // A wedged server holding the SSE open with comment heartbeats produces NO
  // assistant events — indistinguishable from post-headers silence here.
  const run = runGuard(scriptedIterable([{ event: startEvent() }]));
  await flushUntil(() => run.timers.length >= 2, "start consumed");
  run.fireLatest();
  await expectCategory(run.result, "timeout_first_token");
});

test("empty and whitespace content deltas never count as a first token", async () => {
  const entries: ScriptEntry[] = [{ event: startEvent() }];
  for (let i = 0; i < 10; i++) {
    entries.push({ event: { type: "text_delta", contentIndex: 0, delta: i % 2 === 0 ? "" : "  \n ", partial: messageWith("") } });
  }
  const run = runGuard(scriptedIterable(entries));
  await flushUntil(() => run.timers.length >= 12, "all deltas consumed");
  const latest = run.timers.at(-1);
  assert.equal(latest?.ms, FAST.firstTokenMs, "empty deltas must not reset the absolute first-token budget");
  run.fireLatest();
  const error = await expectCategory(run.result, "timeout_first_token");
  assert.ok(error.metrics?.connectLatencyMs !== undefined, "deltas DID connect — they just were not meaningful");
  assert.equal(error.metrics?.firstTokenLatencyMs, undefined);
});

test("valid reasoning_content (thinking delta) IS the first meaningful token", async () => {
  const run = runGuard(
    scriptedIterable([
      { event: startEvent() },
      { advanceMs: 40, event: { type: "thinking_delta", contentIndex: 0, delta: "checking the claim…", partial: messageWith("") } },
      { advanceMs: 20, event: doneEvent("", "full reasoning payload") },
    ]),
  );
  const { metrics } = await run.result;
  assert.equal(metrics.firstTokenLatencyMs, 40, "first meaningful token latency comes from the thinking delta");
  assert.equal(metrics.totalLatencyMs, 60);
});

test("text_end with content also counts (providers that skip deltas)", async () => {
  const run = runGuard(
    scriptedIterable([
      { event: startEvent() },
      { advanceMs: 30, event: { type: "text_end", contentIndex: 0, content: "the answer", partial: messageWith("the answer") } },
      { event: doneEvent("the answer") },
    ]),
  );
  const { metrics } = await run.result;
  assert.equal(metrics.firstTokenLatencyMs, 30);
});

test("first-token timeout aborts the transport exactly once, at the first-token deadline", async () => {
  const aborts: ReviewerCallError[] = [];
  const run = runGuard(scriptedIterable([{ event: startEvent() }]), { onAbortTransport: (error) => aborts.push(error) });
  await flushUntil(() => run.timers.length >= 2, "start consumed");
  run.fireLatest();
  await expectCategory(run.result, "timeout_first_token");
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0].category, "timeout_first_token");
  assert.equal(run.timers.at(-1)?.ms, FAST.firstTokenMs, "transport aborted at the first-token deadline, not the total");
});

test("total deadline still bounds slow-but-real generation", async () => {
  const run = runGuard(
    scriptedIterable([
      { event: startEvent() },
      { advanceMs: 50, event: { type: "thinking_delta", contentIndex: 0, delta: "real token", partial: messageWith("") } },
    ]),
    { deadlines: { connectMs: 100, firstTokenMs: 120, totalMs: 300 } },
  );
  await flushUntil(() => run.timers.length >= 3, "meaningful token consumed, total deadline armed");
  assert.equal(run.timers.at(-1)?.ms, 250, "after a meaningful token only the total budget remains (300ms − 50ms used)");
  run.fireLatest();
  const error = await expectCategory(run.result, "timeout_total");
  assert.equal(error.metrics?.firstTokenLatencyMs, 50, "first token arrived before the total deadline");
});

test("connection deadline fires when not even headers arrive", async () => {
  const run = runGuard(scriptedIterable([]), { deadlines: { connectMs: 100, firstTokenMs: 5_000, totalMs: 10_000 } });
  assert.equal(run.timers.at(-1)?.ms, 100, "the connect deadline is the tightest clock before any event");
  run.fireLatest();
  const error = await expectCategory(run.result, "timeout_connect");
  assert.equal(error.metrics?.connectLatencyMs, undefined);
});

test("clean completion with zero meaningful content → empty_completion (wedged-server signature)", async () => {
  const run = runGuard(scriptedIterable([{ event: startEvent() }, { advanceMs: 20, event: doneEvent("") }]));
  await expectCategory(run.result, "empty_completion");
});

test("malformed stream chunks classify separately from transport errors", async () => {
  const badChunk = runGuard(scriptedIterable([{ event: startEvent() }, { throwError: new Error("Unexpected token < in JSON at position 0") }]));
  await expectCategory(badChunk.result, "malformed_stream");

  const socketDeath = runGuard(scriptedIterable([{ event: startEvent() }, { throwError: new Error("socket hang up") }]));
  await expectCategory(socketDeath.result, "transport");
});

test("caller abort cancels promptly AND settles the stream iterator (no abandoned generator)", async () => {
  const stream = scriptedIterable([{ event: startEvent() }]);
  const controller = new AbortController();
  const run = runGuard(stream, { signal: controller.signal, deadlines: { connectMs: 5_000, firstTokenMs: 5_000, totalMs: 30_000 } });
  await flushUntil(() => run.timers.length >= 2, "start consumed");
  controller.abort();
  await expectCategory(run.result, "aborted");
  assert.equal(stream.returned, true, "iterator.return() must settle the stream");
  // No deadline timer fired — the abort beat every clock.
  assert.ok(run.timers.every((timer) => timer.cancelled));
});

test("deadline failure also settles the stream iterator", async () => {
  const stream = scriptedIterable([]);
  const run = runGuard(stream, { deadlines: { connectMs: 60, firstTokenMs: 120, totalMs: 300 } });
  run.fireLatest();
  await expectCategory(run.result, "timeout_connect");
  assert.equal(stream.returned, true);
});
