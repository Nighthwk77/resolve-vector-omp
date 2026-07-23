import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";
import { runDoctorChecks } from "../src/doctor.js";
import { DEFAULT_CONFIG, type ResolveVectorConfig, type ReviewerConfig } from "../src/policy.js";
import type { RVEngine } from "../src/runtime.js";
import { ReviewerCallError } from "../src/stream-guard.js";

const qwenReviewer: ReviewerConfig = {
  id: "qwen",
  provider: "vllm-mlx",
  model: "qwen3-coder",
  family: "qwen",
  role: "critic",
  local: true,
  enabled: true,
  order: 1,
};

/** Loopback server double: `/v1/models` answers 200 instantly (the wedge). */
async function startWedgedServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen3-coder" }] }));
      return;
    }
    // Everything else (chat completions) hangs — the observed failure shape.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface Harness {
  runtime: RVEngine;
  ctx: ExtensionCommandContext;
  circuits: CircuitBreakerRegistry;
}

async function makeHarness(
  baseUrl: string,
  complete: RVEngine["complete"],
  configOverrides: Partial<ResolveVectorConfig> = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "rv-doctor-"));
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, reviewers: [qwenReviewer], ...configOverrides };
  const circuits = new CircuitBreakerRegistry({ cooldownMs: 300_000 });
  const runtime: RVEngine = {
    paths: { configPath: join(dir, "resolve-vector.json"), receiptsPath: join(dir, "r.jsonl"), ledgerPath: join(dir, "b.jsonl") },
    config,
    circuits,
    complete,
    configErrors: [],
    configCreated: false,
    setMode: () => {},
    runReview: () => Promise.reject(new Error("not under test")),
    runEnsemble: () => Promise.reject(new Error("not under test")),
    recentReceipts: () => Promise.resolve([]),
    reload: () => Promise.resolve(),
  };
  const model = { provider: "vllm-mlx", id: "qwen3-coder", baseUrl, name: "qwen3-coder" };
  const ctx = {
    models: {
      resolve: (ref: string) => (ref.includes("qwen3-coder") ? model : undefined),
      family: () => "qwen",
    },
    modelRegistry: { getApiKey: async () => undefined },
  } as unknown as ExtensionCommandContext;
  return { runtime, ctx, circuits };
}

test("/v1/models answers but completion hangs: endpoint reachable ≠ generation healthy", async () => {
  const server = await startWedgedServer();
  try {
    // The probe transport replays the production guard's verdict on a wedged seat.
    const complete: RVEngine["complete"] = async () => {
      throw new ReviewerCallError("timeout_first_token", "no meaningful token within 10s — generation unresponsive", {
        connectLatencyMs: 12,
        totalLatencyMs: 10_000,
      });
    };
    const { runtime, ctx, circuits } = await makeHarness(server.baseUrl, complete);
    const checks = await runDoctorChecks(runtime, ctx, "17.0.7", { probe: true });

    const reachable = checks.find((c) => c.label.includes("endpoint reachable"));
    assert.equal(reachable?.ok, true, "HTTP reachability alone still reports — correctly labeled");
    assert.match(reachable?.label ?? "", /NOT proof of generation health/);

    const generation = checks.find((c) => c.label.includes("generation UNHEALTHY"));
    assert.equal(generation?.ok, false);
    assert.match(generation?.label ?? "", /timeout_first_token/);
    assert.match(generation?.fix ?? "", /Restart the vllm-mlx service, then run \/rv doctor\./);

    // The failed probe opened the circuit — the next council skips this seat.
    assert.equal(circuits.snapshot("qwen").state, "open");
  } finally {
    await server.close();
  }
});

test("healthy probe reports generation health with first-token latency", async () => {
  const server = await startWedgedServer();
  try {
    const complete: RVEngine["complete"] = async () => ({
      text: "ok",
      metrics: { connectLatencyMs: 8, firstTokenLatencyMs: 640, totalLatencyMs: 700 },
    });
    const { runtime, ctx, circuits } = await makeHarness(server.baseUrl, complete);
    const checks = await runDoctorChecks(runtime, ctx, "17.0.7", { probe: true });
    const generation = checks.find((c) => c.label.includes("generation healthy"));
    assert.equal(generation?.ok, true);
    assert.match(generation?.label ?? "", /first meaningful token in 640ms/);
    assert.equal(circuits.snapshot("qwen").state, "closed");
  } finally {
    await server.close();
  }
});

test("doctor probe is the half-open trial: success closes an open circuit", async () => {
  const server = await startWedgedServer();
  try {
    const complete: RVEngine["complete"] = async () => ({
      text: "ok",
      metrics: { connectLatencyMs: 5, firstTokenLatencyMs: 200, totalLatencyMs: 220 },
    });
    const { runtime, ctx, circuits } = await makeHarness(server.baseUrl, complete);
    circuits.recordFailure("qwen", "timeout_first_token");
    assert.equal(circuits.snapshot("qwen").state, "open");

    const checks = await runDoctorChecks(runtime, ctx, "17.0.7", { probe: true });
    assert.equal(circuits.snapshot("qwen").state, "closed", "successful probe closed the circuit");
    assert.ok(checks.some((c) => c.label.includes("generation healthy")));
  } finally {
    await server.close();
  }
});

test("without the probe flag doctor proves reachability only — never claims generation health", async () => {
  const server = await startWedgedServer();
  try {
    const complete: RVEngine["complete"] = () => Promise.reject(new Error("must not be called without probe"));
    const { runtime, ctx } = await makeHarness(server.baseUrl, complete);
    const checks = await runDoctorChecks(runtime, ctx, "17.0.7");
    assert.ok(!checks.some((c) => c.label.includes("generation healthy")), "no generation claim without probing");
    assert.ok(checks.some((c) => c.label.includes("endpoint reachable")));
  } finally {
    await server.close();
  }
});

test("open circuit is reported with remaining cooldown and the retry hint", async () => {
  const server = await startWedgedServer();
  try {
    const complete: RVEngine["complete"] = () => Promise.reject(new Error("not under test"));
    const { runtime, ctx, circuits } = await makeHarness(server.baseUrl, complete);
    circuits.recordFailure("qwen", "timeout_first_token");
    const checks = await runDoctorChecks(runtime, ctx, "17.0.7");
    const circuit = checks.find((c) => c.label.includes("circuit open"));
    assert.ok(circuit);
    assert.match(circuit?.label ?? "", /timeout_first_token/);
    assert.match(circuit?.label ?? "", /cooldown left/);
    assert.match(circuit?.fix ?? "", /\/rv reviewer retry qwen/);
  } finally {
    await server.close();
  }
});
