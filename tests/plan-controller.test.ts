import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand } from "../src/shell-classifier.js";
import {
  PlanController,
  RV_PLAN_PROMPT_TYPE,
  RV_PLAN_RETHINK_TYPE,
  RV_PLAN_STEERING_TYPE,
} from "../src/plan-controller.js";
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

function ownedTurn(
  pc: PlanController,
  proposal: string,
  customType: typeof RV_PLAN_PROMPT_TYPE | typeof RV_PLAN_RETHINK_TYPE | typeof RV_PLAN_STEERING_TYPE,
): unknown[] {
  return [
    {
      role: "custom",
      customType,
      details: { correlationId: pc.currentState.correlationId },
      content: [{ type: "text", text: "hidden RV context" }],
    },
    { role: "assistant", content: proposal },
  ];
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
  assert.equal(classifyShellCommand("git status; curl https://example.com").readOnly, false);
  assert.equal(classifyShellCommand("git status && unknown-command").readOnly, false);
  assert.equal(classifyShellCommand("rg pattern | sh").readOnly, false);
  assert.equal(classifyShellCommand("rg --pre ./script pattern").readOnly, false);
  assert.equal(classifyShellCommand("find . -delete").readOnly, false);
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

  await pc.onAgentEnd(
    ownedTurn(pc, "1. Step A: Implement feature\n2. Step B: Test feature", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );

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
  await pc.onAgentEnd(
    ownedTurn(pc, "1. Step A: Implement feature\n2. Step B: Test feature", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );

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
  await pc.onAgentEnd(
    ownedTurn(pc, "1. Initial Plan for feature implementation", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );

  assert.equal(pc.currentState.state, "rethinking");
  assert.equal(pc.currentState.rethinkRound, 1);
  assert.ok(rethinkPrompt.includes("Rethink the plan"));
});

test("PlanController: ignores an uncorrelated plan completion", async () => {
  const runtime = makeFakeRuntime("ask", "pass");
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
  await pc.onAgentEnd(
    [
      { role: "custom", customType: RV_PLAN_PROMPT_TYPE, details: { correlationId: "wrong" } },
      { role: "assistant", content: "A complete but unrelated plan" },
    ],
    {} as any,
  );
  assert.equal(pc.currentState.state, "planning");
  assert.equal(pc.currentState.originalPlan, undefined);
});

test("PlanController: ordinary steering reopens rethink and remains mutation-blocked", async () => {
  const runtime = makeFakeRuntime("ask", "pass");
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
  await pc.onAgentEnd(
    ownedTurn(pc, "1. Implement safely\n2. Test it", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );
  assert.equal(pc.currentState.state, "awaitingUser");

  const steering = pc.onBeforeAgentStart("Keep the public API unchanged", {} as any);
  assert.equal(pc.currentState.state, "rethinking");
  assert.equal(pc.onToolCall("edit", {}).block, true);
  assert.equal(
    typeof steering?.message === "object" && steering.message !== null
      ? steering.message.customType
      : undefined,
    RV_PLAN_STEERING_TYPE,
  );

  await pc.onAgentEnd(
    ownedTurn(pc, "1. Preserve the public API\n2. Implement internally\n3. Test compatibility", RV_PLAN_STEERING_TYPE),
    {} as any,
  );
  assert.equal(pc.currentState.state, "awaitingUser");
  assert.match(pc.currentState.revisedPlan ?? "", /Preserve the public API/);
});

test("PlanController: plain-English approval executes without another planning round", async () => {
  const runtime = makeFakeRuntime("ask", "pass");
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
  await pc.onAgentEnd(
    ownedTurn(pc, "1. Implement safely\n2. Test it", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );
  const approval = pc.onBeforeAgentStart("go ahead", {} as any);
  assert.equal(pc.currentState.state, "executing");
  assert.equal(
    typeof approval?.message === "object" && approval.message !== null
      ? approval.message.customType
      : undefined,
    "rv-plan-execute",
  );
  assert.equal(pc.onToolCall("edit", {}).block, false);
});

test("PlanController: auto mode escalates destructive and external plans", async () => {
  for (const goal of ["delete the old database", "deploy this release to production"]) {
    const runtime = makeFakeRuntime("auto", "pass");
    let executeCalls = 0;
    const pc = new PlanController(runtime, {
      notify: () => {},
      sendPlanPrompt: () => {},
      sendRethinkPrompt: () => {},
      sendExecutePrompt: () => {
        executeCalls += 1;
      },
      leafEntryId: () => "leaf-1",
      lastExchange: () => ({}),
      primaryFamily: () => "glm",
    });
    pc.onBeforeAgentStart(goal);
    await pc.onAgentEnd(
      ownedTurn(pc, `1. ${goal}\n2. Verify the result`, RV_PLAN_PROMPT_TYPE),
      {} as any,
    );
    assert.equal(pc.currentState.state, "awaitingUser", goal);
    assert.equal(executeCalls, 0, goal);
  }
});

test("PlanController: execution completion releases the next task", async () => {
  const runtime = makeFakeRuntime("auto", "pass");
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
  await pc.onAgentEnd(
    ownedTurn(pc, "1. Implement safely\n2. Test it", RV_PLAN_PROMPT_TYPE),
    {} as any,
  );
  assert.equal(pc.currentState.state, "executing");
  pc.finishExecution();
  assert.equal(pc.currentState.state, "idle");
  assert.ok(pc.onBeforeAgentStart("fix the next issue"));
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
