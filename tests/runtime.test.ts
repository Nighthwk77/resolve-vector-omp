import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, type ResolveVectorConfig, type ReviewerConfig } from "../src/policy.js";
import { RVRuntime, type RuntimePaths } from "../src/runtime.js";

const remoteReviewer: ReviewerConfig = {
  id: "remote-seat",
  provider: "deepseek",
  model: "deepseek-chat",
  family: "deepseek",
  role: "critic",
  local: false,
  enabled: true,
  order: 1,
};

function configCap(hourly: number): ResolveVectorConfig {
  return {
    ...DEFAULT_CONFIG,
    maxExternalAuditsPerHour: hourly,
    reviewers: [remoteReviewer],
  };
}

/** ctx double: only the models/modelRegistry surface resolveReviewer touches. */
function fakeCtx(): ExtensionContext {
  const ctx = {
    models: {
      resolve: (spec: string) => ({ provider: spec.split("/")[0], id: spec }),
      family: () => "deepseek-fam",
    },
    modelRegistry: { getApiKey: async () => "fake-key" },
  };
  return ctx as unknown as ExtensionContext;
}

const passOutput = { text: JSON.stringify({ status: "pass", summary: "ok", findings: [] }), usage: { input: 1, output: 1 } };

async function makePaths(): Promise<RuntimePaths> {
  const dir = await mkdtemp(join(tmpdir(), "rv-runtime-"));
  return {
    configPath: join(dir, "config.json"),
    receiptsPath: join(dir, "receipts.jsonl"),
    ledgerPath: join(dir, "budget.jsonl"),
  };
}

async function writeConfig(paths: RuntimePaths, config: ResolveVectorConfig): Promise<void> {
  await writeFile(paths.configPath, JSON.stringify(config), "utf8");
}

const baseRequest = {
  goal: "g",
  proposal: "p",
  primaryFamily: "glm-fam", // ≠ deepseek-fam: cross-family check passes
  activationReason: "manual_command" as const,
};

test("concurrent runReview calls share one budget — no snapshot race", async () => {
  const paths = await makePaths();
  await writeConfig(paths, configCap(1));
  let dispatches = 0;
  const runtime = await RVRuntime.load(paths, {
    complete: async () => {
      dispatches += 1;
      return passOutput;
    },
  });
  const ctx = fakeCtx();
  const [first, second] = await Promise.all([runtime.runReview(ctx, baseRequest), runtime.runReview(ctx, baseRequest)]);
  assert.equal(dispatches, 1);
  const statuses = [first, second].map((v) => v.reviewers[0].status).sort();
  assert.deepEqual(statuses, ["ok", "skipped_budget"]);
});

test("two runtimes (separate omp processes) share the ledger budget", async () => {
  const paths = await makePaths();
  await writeConfig(paths, configCap(1));
  let dispatches = 0;
  const complete = async () => {
    dispatches += 1;
    return passOutput;
  };
  const runtimeA = await RVRuntime.load(paths, { complete });
  const runtimeB = await RVRuntime.load(paths, { complete });
  const ctx = fakeCtx();
  const [first, second] = await Promise.all([runtimeA.runReview(ctx, baseRequest), runtimeB.runReview(ctx, baseRequest)]);
  assert.equal(dispatches, 1);
  const statuses = [first, second].map((v) => v.reviewers[0].status).sort();
  assert.deepEqual(statuses, ["ok", "skipped_budget"]);
});

test("attempts stay counted when receipt persistence fails", async () => {
  const paths = await makePaths();
  await writeConfig(paths, configCap(1));
  // Break receipt persistence: receiptsPath goes THROUGH a regular file, so mkdir fails.
  const dir = paths.receiptsPath.replace(/\/receipts\.jsonl$/, "");
  await writeFile(join(dir, "blocker"), "x", "utf8");
  const brokenPaths: RuntimePaths = { ...paths, receiptsPath: join(dir, "blocker", "r.jsonl") };
  let dispatches = 0;
  const runtimeBroken = await RVRuntime.load(brokenPaths, {
    complete: async () => {
      dispatches += 1;
      return passOutput;
    },
  });
  await assert.rejects(runtimeBroken.runReview(fakeCtx(), baseRequest));
  assert.equal(dispatches, 1); // the attempt happened…

  // …and a healthy runtime against the SAME ledger still sees the spent budget.
  const runtimeHealthy = await RVRuntime.load(paths, { complete: async () => passOutput });
  const verdict = await runtimeHealthy.runReview(fakeCtx(), baseRequest);
  assert.equal(verdict.reviewers[0].status, "skipped_budget");
  assert.equal(verdict.reviewers[0].calls, 0);
});

test("ledger bootstraps from historical receipts exactly once", async () => {
  const paths = await makePaths();
  await writeConfig(paths, configCap(1));
  // A historical external call inside the hourly window.
  const historical = {
    receiptId: "rv-hist",
    activationReason: "manual_command",
    revisionRound: 0,
    verdict: {
      id: "rv-hist",
      mode: "review",
      status: "pass",
      summary: "s",
      findings: [],
      reviewers: [
        {
          reviewerId: "old",
          provider: "deepseek",
          model: "m",
          family: "deepseek",
          local: false,
          status: "ok",
          calls: 1,
          findings: [],
          latencyMs: 1,
        },
      ],
      deterministicChecks: [],
      usage: { input: 0, output: 0, totalLatencyMs: 1 },
      createdAt: new Date().toISOString(),
    },
  };
  await writeFile(paths.receiptsPath, `${JSON.stringify(historical)}\n`, "utf8");
  let dispatches = 0;
  const runtime = await RVRuntime.load(paths, {
    complete: async () => {
      dispatches += 1;
      return passOutput;
    },
  });
  const verdict = await runtime.runReview(fakeCtx(), baseRequest);
  assert.equal(verdict.reviewers[0].status, "skipped_budget"); // seed counted
  assert.equal(dispatches, 0);

  // The ledger persisted the seed; a fresh runtime must not double-bootstrap.
  const ledger = await readFile(paths.ledgerPath, "utf8");
  const seedLines = ledger.trim().split("\n").filter((l) => l.includes('"seed-'));
  assert.equal(seedLines.length, 1);
});

test("reservations carry unique ids even at identical timestamps", async () => {
  const paths = await makePaths();
  await writeConfig(paths, configCap(10));
  const runtime = await RVRuntime.load(paths, { complete: async () => passOutput });
  const ctx = fakeCtx();
  await Promise.all([runtime.runReview(ctx, baseRequest), runtime.runReview(ctx, baseRequest)]);
  const ledger = (await readFile(paths.ledgerPath, "utf8")).trim().split("\n");
  assert.equal(ledger.length, 2);
  const ids = ledger.map((line) => (JSON.parse(line) as { id: string }).id);
  assert.notEqual(ids[0], ids[1]);
});
