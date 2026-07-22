import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEFAULT_CONFIG, type ResolveVectorConfig } from "../src/policy.js";
import type { CouncilVerdict } from "../src/receipts.js";
import type { RVEngine, RunReviewRequest } from "../src/runtime.js";
import { registerCouncilAuditTool } from "../src/tool.js";

interface CapturedCall {
  request: RunReviewRequest;
  signal?: AbortSignal;
}

const fakeVerdict: CouncilVerdict = {
  id: "rv-test",
  mode: "review",
  status: "pass",
  summary: "fine",
  findings: [],
  reviewers: [],
  deterministicChecks: [],
  usage: { input: 0, output: 0, totalLatencyMs: 1 },
  createdAt: new Date(0).toISOString(),
};

type Execute = (
  id: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult>;

function makeTool(captured: CapturedCall[]): (params: unknown, signal?: AbortSignal) => Promise<AgentToolResult> {
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, reviewers: [] };
  config.reviewers.push({
    id: "seat",
    provider: "p",
    model: "m",
    family: "f",
    role: "critic",
    local: true,
    enabled: true,
    order: 1,
  });
  const engine: RVEngine = {
    paths: { configPath: "/tmp/rv-fake/config.json", receiptsPath: "/tmp/rv-fake/r.jsonl", ledgerPath: "/tmp/rv-fake/b.jsonl" },
    config,
    configErrors: [],
    configCreated: false,
    setMode: () => {},
    runReview: (_ctx, request, signal) => {
      captured.push({ request, signal });
      return Promise.resolve(fakeVerdict);
    },
    recentReceipts: () => Promise.resolve([]),
  };
  let execute: Execute | undefined;
  // TypeBox shim double: the tool only calls these builders; contents are irrelevant here.
  const stub = () => ({});
  const pi = {
    typebox: {
      Type: { Object: stub, Enum: stub, String: stub, Optional: stub, Array: stub },
    },
    registerTool: (definition: { execute: Execute }) => {
      execute = definition.execute;
    },
  };
  registerCouncilAuditTool(pi as unknown as ExtensionAPI, engine);
  assert.ok(execute, "council_audit must register");
  const registered: Execute = execute;
  const ctx = { model: undefined } as unknown as ExtensionContext;
  return (params, signal) => registered("tc-1", params, signal, undefined, ctx);
}

function resultText(result: AgentToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

test("council_audit rejects the removed profile param with an actionable error", async () => {
  const captured: CapturedCall[] = [];
  const run = makeTool(captured);
  const result = await run({ mode: "review", goal: "g", proposal: "p", profile: "source-faithfulness" });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /profile is not supported/);
  assert.equal(captured.length, 0); // never reached the engine
});

test("council_audit flows evidence into the review request", async () => {
  const captured: CapturedCall[] = [];
  const run = makeTool(captured);
  const result = await run({
    mode: "review",
    goal: "port spell X",
    proposal: "the port…",
    evidence: [
      { kind: "file", ref: "engine.cpp:412", detail: "coefficient source" },
      { ref: "no-kind-entry" },
      { kind: "bogus", ref: "bad-kind" },
      "junk",
    ],
  });
  assert.equal(result.isError, false);
  assert.equal(captured.length, 1);
  const evidence = captured[0].request.evidence ?? [];
  assert.equal(evidence.length, 3); // junk entry dropped
  assert.deepEqual(evidence[0], { kind: "file", ref: "engine.cpp:412", detail: "coefficient source" });
  assert.equal(evidence[1].kind, "other"); // missing kind → other
  assert.equal(evidence[2].kind, "other"); // invalid kind → other
});

test("council_audit wires the parent AbortSignal into runReview", async () => {
  const captured: CapturedCall[] = [];
  const run = makeTool(captured);
  const controller = new AbortController();
  await run({ mode: "review", goal: "g", proposal: "p" }, controller.signal);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].signal, controller.signal);
});

test("council_audit ensemble modes fail with a clear not-implemented error", async () => {
  const captured: CapturedCall[] = [];
  const run = makeTool(captured);
  const result = await run({ mode: "best", goal: "g", candidateCount: 3 });
  assert.equal(result.isError, true);
  assert.match(resultText(result), /not implemented yet/);
  assert.equal(captured.length, 0);
});
