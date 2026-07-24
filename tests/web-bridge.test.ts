import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain-JS browser-side module
import { createBridgeServer } from "../src/web/bridge-core.mjs";
import { FakeContext, FakePage } from "./web-fakes.js";

async function req(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let nextPort = 7750;
async function withServer(
  getContext: () => Promise<FakeContext>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const port = nextPort++;
  const server = createBridgeServer({ getContext, port });
  await new Promise<void>((r, rj) => server.listen(port, "127.0.0.1", r).on("error", rj));
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function readyContext(): FakeContext {
  return new FakeContext(() =>
    new FakePage({
      bodyText: "Ask anything\nNew chat",
      inputs: [{ visible: true }],
      responseSequence: ["", "answer", "answer", "answer"],
    }),
  );
}

test("bridge /health identifies the bridge and lists providers", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status, json } = await req(port, "GET", "/health");
    assert.equal(status, 200);
    const body = json as { ok: boolean; bridge: string; providers: string[] };
    assert.equal(body.ok, true);
    assert.equal(body.bridge, "rv-web-bridge");
    assert.ok(body.providers.length >= 7, "all providers enumerated");
  });
});

test("bridge /state returns the detected page state", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status, json } = await req(port, "POST", "/state", { app: "deepseek" });
    assert.equal(status, 200);
    const body = json as { state: string; popupClicks: number };
    assert.equal(body.state, "ready_anonymous");
    assert.ok(body.popupClicks >= 0);
  });
});

test("bridge /state rejects an unknown provider", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status, json } = await req(port, "POST", "/state", { app: "nosuchprovider" });
    assert.equal(status, 500);
    assert.match((json as { error: string }).error, /unknown web provider/);
  });
});

test("bridge /consult streams a verdict for a ready page", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status, json } = await req(port, "POST", "/consult", { app: "deepseek", prompt: "review this", timeoutMs: 1000 });
    assert.equal(status, 200);
    const body = json as { ok: boolean; text: string };
    assert.equal(body.ok, true);
    assert.equal(body.text, "answer");
  });
});

test("bridge /consult without a prompt is a 400", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status, json } = await req(port, "POST", "/consult", { app: "deepseek" });
    assert.equal(status, 400);
    assert.match((json as { error: string }).error, /prompt is required/);
  });
});

test("bridge /consult into a login wall returns 502 with login_required", async () => {
  const ctx = new FakeContext(() =>
    new FakePage({ bodyText: "Welcome back\nContinue with Google", inputs: [], authInputCount: 2 }),
  );
  await withServer(() => Promise.resolve(ctx), async (port) => {
    const { status, json } = await req(port, "POST", "/consult", { app: "perplexity", prompt: "review this", timeoutMs: 1000 });
    assert.equal(status, 502);
    assert.equal((json as { category: string }).category, "login_required");
  });
});

test("bridge unknown endpoint is 404", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const { status } = await req(port, "GET", "/nope");
    assert.equal(status, 404);
  });
});

test("bridge rejects bodies over the 512KB cap without crashing", async () => {
  await withServer(() => Promise.resolve(readyContext()), async (port) => {
    const huge = "x".repeat(600_000);
    const res = await req(port, "POST", "/consult", { app: "deepseek", prompt: huge, timeoutMs: 1000 });
    // The readBody cap rejects before consulting; surface as a 500 error.
    assert.ok(res.status >= 400, "oversized body rejected");
  });
});
