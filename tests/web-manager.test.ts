import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { WebBridgeManager } from "../src/web/manager.js";

async function startStub(port: number, handlers: Record<string, (body: unknown) => unknown>): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    try {
      const key = `${req.method} ${url.pathname}`;
      const h = handlers[key];
      if (h) return send(200, h(body));
      send(404, { error: "no handler" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

test("WebBridgeManager.status: reports running when /health identifies the RV bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-mgr-"));
  const port = 7701;
  const server = await startStub(port, {
    "GET /health": () => ({ ok: true, bridge: "rv-web-bridge", providers: ["deepseek"], pid: 1 }),
  });
  await writeFile(join(dir, "rv-web-bridge.json"), JSON.stringify({ pid: 1, port, startedAt: new Date().toISOString() }));
  try {
    const mgr = new WebBridgeManager(dir, "/no/bridge");
    const status = await mgr.status();
    assert.equal(status.running, true);
    assert.equal(status.port, port);
    assert.deepEqual(status.providers, ["deepseek"]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("WebBridgeManager.status: detects a foreign service squatting on the port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-mgr-"));
  const port = 7702;
  const server = await startStub(port, { "GET /health": () => ({ ok: true, service: "something-else" }) });
  await writeFile(join(dir, "rv-web-bridge.json"), JSON.stringify({ pid: 1, port, startedAt: new Date().toISOString() }));
  try {
    const mgr = new WebBridgeManager(dir, "/no/bridge");
    const status = await mgr.status();
    assert.equal(status.running, false);
    assert.match(status.error ?? "", /not the RV web bridge/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("WebBridgeManager.detectState: proxies the bridge and returns the verdict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-mgr-"));
  const port = 7703;
  let shutdownHit = false;
  const server = await startStub(port, {
    "GET /health": () => ({ ok: true, bridge: "rv-web-bridge", providers: [], pid: 1 }),
    "POST /state": (b) => ({ app: (b as { app: string }).app, state: "ready_anonymous", popupClicks: 0 }),
    "POST /consult": (b) => ({ ok: true, text: "RV-OK", popupClicks: 0, retries: 0, sessionState: "ready_anonymous", app: (b as { app: string }).app }),
    "POST /shutdown": () => {
      shutdownHit = true;
      return { ok: true };
    },
  });
  await writeFile(join(dir, "rv-web-bridge.json"), JSON.stringify({ pid: 1, port, startedAt: new Date().toISOString() }));
  try {
    const mgr = new WebBridgeManager(dir, "/no/bridge");
    const detected = await mgr.detectState("deepseek");
    assert.equal(detected.state, "ready_anonymous");
    assert.equal(detected.app, "deepseek");

    const result = await mgr.consult("deepseek", "say RV-OK", 5000);
    assert.equal(result.ok, true);
    assert.equal(result.text, "RV-OK");

    await mgr.shutdown();
    assert.equal(shutdownHit, true, "shutdown forwards to the bridge /shutdown endpoint");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("WebBridgeManager.ensure: reuses a healthy recorded bridge without respawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-mgr-"));
  const port = 7704;
  const server = await startStub(port, {
    "GET /health": () => ({ ok: true, bridge: "rv-web-bridge", providers: [], pid: 1 }),
  });
  await writeFile(join(dir, "rv-web-bridge.json"), JSON.stringify({ pid: 1, port, startedAt: new Date().toISOString() }));
  try {
    const mgr = new WebBridgeManager(dir, "/no/bridge");
    const first = await mgr.ensure();
    const second = await mgr.ensure();
    assert.equal(first.running, true);
    assert.equal(second.running, true);
    assert.equal(first.port, second.port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
