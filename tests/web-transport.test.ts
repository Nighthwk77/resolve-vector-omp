import { test } from "node:test";
import assert from "node:assert/strict";
import { WebTransport, WebConsultError } from "../src/web/transport.js";
import type { WebBridgeManager, ConsultResult } from "../src/web/manager.js";
import type { ResolvedReviewer } from "../src/providers.js";
import type { ResolveVectorConfig } from "../src/policy.js";

class FakeManager implements Pick<WebBridgeManager, "consult" | "status" | "detectState"> {
  consultCalls: { app: string; prompt: string }[] = [];
  nextResult: ConsultResult = { ok: true, text: "RV-OK", popupClicks: 0, retries: 0, sessionState: "ready_anonymous" };
  consultLatencyMs = 0;
  async consult(app: string, prompt: string): Promise<ConsultResult> {
    this.consultCalls.push({ app, prompt });
    if (this.consultLatencyMs > 0) await new Promise((r) => setTimeout(r, this.consultLatencyMs));
    return this.nextResult;
  }
  async status(): Promise<{ running: boolean; port?: number; providers?: string[]; error?: string }> {
    return { running: true, port: 3037, providers: [] };
  }
  async detectState(): Promise<{ state: "ready_anonymous"; popupClicks: number; app: string }> {
    return { state: "ready_anonymous", popupClicks: 0, app: "deepseek" };
  }
}

function makeConfig(webAdvisors: ResolveVectorConfig["webAdvisors"]): ResolveVectorConfig {
  return { webAdvisors, reviewers: [] } as unknown as ResolveVectorConfig;
}
function makeReviewer(app: string): ResolvedReviewer {
  return { config: { provider: `web:${app}`, id: app }, model: { id: app, provider: `web:${app}` } as never } as unknown as ResolvedReviewer;
}

test("WebTransport: refuses to consult when opt-in is off", async () => {
  const mgr = new FakeManager();
  const t = new WebTransport("/tmp", "/nope", () => makeConfig({ optIn: false, cooldownMs: 60_000 }), mgr as unknown as WebBridgeManager);
  await assert.rejects(
    () => t.complete(makeReviewer("deepseek"), "s", "u"),
    (e: unknown) => e instanceof WebConsultError && (e as WebConsultError).category === "disabled" && /(web on)/.test(e.message),
  );
  assert.equal(mgr.consultCalls.length, 0, "no consultation issued while disabled");
});

test("WebTransport: consults through the manager and records last-consult time", async () => {
  const mgr = new FakeManager();
  const cfg = makeConfig({ optIn: true, cooldownMs: 0 });
  const t = new WebTransport("/tmp", "/nope", () => cfg, mgr as unknown as WebBridgeManager);
  const out = await t.complete(makeReviewer("kimi"), "system", "user");
  assert.equal(out.text, "RV-OK");
  assert.equal(out.web?.sessionState, "ready_anonymous");
  assert.equal(mgr.consultCalls.length, 1);
  assert.equal(mgr.consultCalls[0].prompt, "system\n\nuser");
});

test("WebTransport: surfaces bridge failure as WebConsultError with provenance", async () => {
  const mgr = new FakeManager();
  mgr.nextResult = { ok: false, error: "blocked", category: "blocked_captcha", popupClicks: 1, retries: 0 };
  const t = new WebTransport("/tmp", "/nope", () => makeConfig({ optIn: true, cooldownMs: 0 }), mgr as unknown as WebBridgeManager);
  await assert.rejects(
    () => t.complete(makeReviewer("chatgpt"), "s", "u"),
    (e: unknown) => {
      const err = e as WebConsultError;
      return err.category === "blocked_captcha" && err.web?.failureCategory === "blocked_captcha" && err.web.popupClicks === 1;
    },
  );
});

test("WebTransport: concurrency 1 — consultations do not overlap", async () => {
  const mgr = new FakeManager();
  mgr.consultLatencyMs = 60;
  const t = new WebTransport("/tmp", "/nope", () => makeConfig({ optIn: true, cooldownMs: 0 }), mgr as unknown as WebBridgeManager);
  const a = t.complete(makeReviewer("kimi"), "s", "u");
  const b = t.complete(makeReviewer("gemini"), "s", "u");
  await Promise.all([a, b]);
  assert.equal(mgr.consultCalls.length, 2, "both ran");
  assert.notEqual(mgr.consultCalls[0].app, mgr.consultCalls[1].app, "serialized: two distinct providers");
});

test("WebTransport: per-provider cooldown is abortable", async () => {
  const mgr = new FakeManager();
  const t = new WebTransport("/tmp", "/nope", () => makeConfig({ optIn: true, cooldownMs: 10_000 }), mgr as unknown as WebBridgeManager);
  // First consult primes lastConsultAt for "deepseek".
  await t.complete(makeReviewer("deepseek"), "s", "u");
  const controller = new AbortController();
  // Second consult for the same provider hits the cooldown wait; abort it.
  const p = t.complete(makeReviewer("deepseek"), "s", "u", { signal: controller.signal } as never);
  controller.abort();
  await assert.rejects(
    () => p,
    (e: unknown) => (e as WebConsultError).category === "cancelled",
  );
  assert.equal(mgr.consultCalls.length, 1, "the cooldown-aborted consult never reached the bridge");
});
