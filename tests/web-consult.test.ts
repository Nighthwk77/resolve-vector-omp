import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain-JS browser-side module
import { consult } from "../src/web/bridge-core.mjs";
import { FakeContext, FakePage } from "./web-fakes.js";

function contextWith(page: FakePage): FakeContext {
  return new FakeContext(() => page);
}

const readyPage = (responses: string[], buttons: { text: string }[] = []) =>
  new FakePage({
    bodyText: "Ask anything\nNew chat",
    inputs: [{ visible: true }],
    buttons,
    responseSequence: responses,
  });

const FAST = { pollMs: 1, responseTimeoutMs: 2000 };

test("consult: happy path returns the response with diagnostics", async () => {
  const page = readyPage(["", "draft", "RV-OK", "RV-OK", "RV-OK"], [{ text: "Got it" }]);
  const result = await consult(contextWith(page), "deepseek", "review this", FAST);
  assert.equal(result.ok, true);
  assert.equal(result.text, "RV-OK");
  assert.equal(result.sessionState, "ready_anonymous");
  assert.equal(result.retries, 0);
  assert.ok(result.popupClicks >= 1, "popup sweeps are counted");
  assert.equal(page.insertedText, "review this");
  assert.ok(page.enterPresses >= 1);
});

test("consult: login wall short-circuits before any typing, never retries", async () => {
  const page = new FakePage({
    bodyText: "Welcome back\nContinue with Google",
    inputs: [],
    authInputCount: 2,
  });
  const result = await consult(contextWith(page), "perplexity", "review this", FAST);
  assert.equal(result.ok, false);
  assert.equal(result.category, "login_required");
  assert.equal(result.retries, 0);
  assert.equal(page.insertedText, "");
  assert.equal(page.enterPresses, 0);
});

test("consult: CAPTCHA is blocked and never retried", async () => {
  const page = new FakePage({ bodyText: "Verify you are human — CAPTCHA" });
  const result = await consult(contextWith(page), "chatgpt", "review this", FAST);
  assert.equal(result.ok, false);
  assert.equal(result.category, "blocked_captcha");
  assert.equal(result.retries, 0);
});

test("consult: unusable page with no wall is broken, not retried", async () => {
  const page = new FakePage({ bodyText: "504 Gateway Timeout", inputs: [] });
  const result = await consult(contextWith(page), "gemini", "review this", FAST);
  assert.equal(result.ok, false);
  assert.equal(result.category, "broken");
  assert.equal(result.retries, 0);
});

test("consult: timeout retries exactly once, then reports", async () => {
  const page = readyPage([""]);
  const result = await consult(contextWith(page), "kimi", "review this", { responseTimeoutMs: 1, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.category, "timeout");
  assert.equal(result.retries, 1, "bounded retries: one and no more");
});

test("consult: cancellation aborts promptly", async () => {
  const page = readyPage(["", "still thinking"]);
  const controller = new AbortController();
  controller.abort();
  const result = await consult(contextWith(page), "glm", "review this", { signal: controller.signal, responseTimeoutMs: 60_000, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.category, "cancelled");
});

test("consult: a closed browser session is reported, not hung", async () => {
  const page = readyPage(["", "still thinking"]);
  page.close();
  const result = await consult(contextWith(page), "claude", "review this", { responseTimeoutMs: 10, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.ok(["session_closed", "timeout", "broken"].includes(result.category));
});

test("consult: usable page with stray Sign in link consults without login", async () => {
  const page = new FakePage({
    bodyText: "Sign in\nAsk anything and get instant answers",
    inputs: [{ visible: true }],
    responseSequence: ["", "answer", "answer", "answer"],
  });
  const result = await consult(contextWith(page), "perplexity", "review this", FAST);
  assert.equal(result.ok, true);
  assert.equal(result.text, "answer");
  assert.equal(result.sessionState, "ready_anonymous");
});
