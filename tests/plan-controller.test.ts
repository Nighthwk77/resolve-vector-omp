import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand } from "../src/shell-classifier.js";
import { PlanController } from "../src/plan-controller.js";
import type { RVEngine } from "../src/runtime.js";
import type { CouncilVerdict } from "../src/receipts.js";

function makeFakeRuntime(mode: "off" | "ask" | "auto" = "ask", verdictStatus: "pass" | "concern" | "fail" = "pass"): RVEngine {
  const mockVerdict: CouncilVerdict = {
    id: "v-test",
    mode: "review",
    status: verdictStatus,
    summary: verdictStatus === "pass" ? "Plan is solid" : "Found 1 issue",
    findings: verdictStatus === "pass" ? [] : [{ severity: "medium", category: "intent", claim: "Missing edge case", concern: "Edge case not handled", evidence: [] }],
    reviewers: [],
    deterministicChecks: [],
    usage: { input: 100, output: 50, totalLatencyMs: 100 },
    createdAt: new Date().toISOString(),
  };

  return {
    config: {
      planning: {
        mode,
        activation: "auto",
        maxRethinkRounds: 2,
        reviewRevisedPlan: true,
        askOnSplit: true,
        askOnCritical: true,
        askOnExternalEffects: true,
      },
    },
    runReview: async () => mockVerdict,
  } as unknown as RVEngine;
}

test("shell-classifier: classifies read-only commands correctly", () => {
  assert.equal(classifyShellCommand("git status").readOnly, true);
  assert.equal(classifyShellCommand("git diff HEAD~1").readOnly, true);
  assert.equal(classifyShellCommand("cat src/index.ts").readOnly, true);
  assert.equal(classifyShellCommand("grep -rn 'test' src/").readOnly, true);
  assert.equal(classifyShellCommand("rtk tsc --noEmit").readOnly, true);
});

test("shell-classifier: classifies mutating commands and fails closed on unknown ones", () => {
  assert.equal(classifyShellCommand("git commit -m 'feat'").readOnly, false);
  assert.equal(classifyShellCommand("rm -rf node_modules").readOnly, false);
  assert.equal(classifyShellCommand("echo 'data' > file.txt").readOnly, false);
  assert.equal(classifyShellCommand("npm install").readOnly, false);
  assert.equal(classifyShellCommand("some-unknown-script.sh").readOnly, false, "unknown script fails closed");
});

test("PlanController: mutation barrier blocks mutating tools during planning", () => {
  const runtime = makeFakeRuntime("ask");
  const notifications: string[] = [];
  const pc = new PlanController(runtime, {
    notify: (_, msg) => notifications.push(msg),
    sendPlanPrompt: () => {},
    sendRethinkPrompt: () => {},
    sendExecutePrompt: () => {},
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "implement feature", proposal: "my plan" }),
    primaryFamily: () => "glm",
  });

  // Activate planning
  pc.onBeforeAgentStart("implement feature X");
  assert.equal(pc.currentState.state, "planning");

  // Read-only tools allowed
  assert.equal(pc.onToolCall("read", { AbsolutePath: "/file" }).block, false);
  assert.equal(pc.onToolCall("grep", { Query: "foo" }).block, false);

  // Mutating tools blocked
  const editRes = pc.onToolCall("edit", { TargetFile: "/file" });
  assert.equal(editRes.block, true);
  assert.match(editRes.reason ?? "", /cannot change files/);

  // Mutating bash command blocked
  const bashRes = pc.onToolCall("bash", { command: "rm -rf foo" });
  assert.equal(bashRes.block, true);

  // Read-only bash command allowed
  const safeBashRes = pc.onToolCall("bash", { command: "git status" });
  assert.equal(safeBashRes.block, false);
});

test("PlanController: mode off bypasses plan review and tool blocking", () => {
  const runtime = makeFakeRuntime("off");
  const pc = new PlanController(runtime, {
    notify: () => {},
    sendPlanPrompt: () => {},
    sendRethinkPrompt: () => {},
    sendExecutePrompt: () => {},
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({}),
    primaryFamily: () => "glm",
  });

  const res = pc.onBeforeAgentStart("implement feature X");
  assert.equal(res, undefined);
  assert.equal(pc.currentState.state, "idle");
  assert.equal(pc.onToolCall("edit", {}).block, false);
});

test("PlanController: ask mode waits for user approval before execution", async () => {
  const runtime = makeFakeRuntime("ask", "pass");
  const notifications: string[] = [];
  let executedPrompt = "";

  const pc = new PlanController(runtime, {
    notify: (_, msg) => notifications.push(msg),
    sendPlanPrompt: () => {},
    sendRethinkPrompt: () => {},
    sendExecutePrompt: (text) => {
      executedPrompt = text;
    },
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "implement x", proposal: "1. Step A\n2. Step B" }),
    primaryFamily: () => "glm",
  });

  pc.onBeforeAgentStart("implement x");
  assert.equal(pc.currentState.state, "planning");

  await pc.onAgentEnd([{ role: "assistant", content: "1. Step A: Implement feature\n2. Step B: Test feature" }], {} as any);

  // Should park in awaitingUser in ask mode
  assert.equal(pc.currentState.state, "awaitingUser");
  assert.equal(executedPrompt, "", "should not execute automatically in ask mode");

  // User approves
  pc.approveAndExecute({} as any);
  assert.equal(pc.currentState.state, "executing");
  assert.ok(executedPrompt.includes("Plan approved"));
});

test("PlanController: auto mode executes safe passing plan automatically", async () => {
  const runtime = makeFakeRuntime("auto", "pass");
  let executedPrompt = "";

  const pc = new PlanController(runtime, {
    notify: () => {},
    sendPlanPrompt: () => {},
    sendRethinkPrompt: () => {},
    sendExecutePrompt: (text) => {
      executedPrompt = text;
    },
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "implement x", proposal: "1. Step A: Implement feature\n2. Step B: Test feature" }),
    primaryFamily: () => "glm",
  });

  pc.onBeforeAgentStart("implement x");
  await pc.onAgentEnd([{ role: "assistant", content: "1. Step A: Implement feature\n2. Step B: Test feature" }], {} as any);

  // Should transition to executing automatically
  assert.equal(pc.currentState.state, "executing");
  assert.ok(executedPrompt.includes("accepted"));
});

test("PlanController: rethink loop triggers on concern and respects maxRethinkRounds", async () => {
  const runtime = makeFakeRuntime("ask", "concern");
  let rethinkPrompt = "";

  const pc = new PlanController(runtime, {
    notify: () => {},
    sendPlanPrompt: () => {},
    sendRethinkPrompt: (text) => {
      rethinkPrompt = text;
    },
    sendExecutePrompt: () => {},
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({ goal: "implement x", proposal: "1. Initial Plan for feature implementation" }),
    primaryFamily: () => "glm",
  });

  pc.onBeforeAgentStart("implement x");
  await pc.onAgentEnd([{ role: "assistant", content: "1. Initial Plan for feature implementation" }], {} as any);

  assert.equal(pc.currentState.state, "rethinking");
  assert.equal(pc.currentState.rethinkRound, 1);
  assert.ok(rethinkPrompt.includes("Rethink the plan"));
});

test("PlanController: session reset aborts and clears state", () => {
  const runtime = makeFakeRuntime("ask");
  const pc = new PlanController(runtime, {
    notify: () => {},
    sendPlanPrompt: () => {},
    sendRethinkPrompt: () => {},
    sendExecutePrompt: () => {},
    leafEntryId: () => "leaf-1",
    lastExchange: () => ({}),
    primaryFamily: () => "glm",
  });

  pc.onBeforeAgentStart("implement feature");
  assert.equal(pc.currentState.state, "planning");

  pc.reset();
  assert.equal(pc.currentState.state, "idle");
  assert.equal(pc.currentState.generation, 1);
});
