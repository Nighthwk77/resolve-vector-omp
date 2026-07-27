import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ActivationController, lastExchangeFromEntries, RV_CORRECTION_TYPE, RV_PLAN_TYPE } from "./activation.js";
import { registerRvCommand } from "./commands.js";
import {
  PlanController,
  RV_PLAN_EXECUTE_TYPE,
  RV_PLAN_PROMPT_TYPE,
  RV_PLAN_RETHINK_TYPE,
} from "./plan-controller.js";
import { defaultPaths, RVRuntime } from "./runtime.js";
import { registerCouncilAuditTool } from "./tool.js";
import { compactGlmUsage, fetchGlmUsage } from "./provider-usage.js";

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && "text" in b)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

export default async function resolveVector(pi: ExtensionAPI): Promise<void> {
  const runtime = await RVRuntime.load(defaultPaths(getAgentDir()));

  const activation = new ActivationController(runtime, {
    notify: (ctx, message, type) => ctx.ui.notify(message, type),
    sendCorrection: (text, correctionId) =>
      pi.sendMessage(
        {
          customType: RV_CORRECTION_TYPE,
          content: [{ type: "text", text }],
          display: false,
          details: { correctionId },
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    sendPlan: (text, planId, correctionId) =>
      pi.sendMessage(
        {
          customType: RV_PLAN_TYPE,
          content: [{ type: "text", text }],
          display: false,
          details: { planId, correctionId },
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    leafEntryId: (ctx) => ctx.sessionManager.getLeafEntry()?.id,
    lastExchange: (ctx) => lastExchangeFromEntries(ctx.sessionManager.getBranch()),
    primaryFamily: (ctx) => (ctx.model ? ctx.models.family(ctx.model) : undefined),
  });

  const planController = new PlanController(runtime, {
    notify: (ctx, message, type) => ctx.ui.notify(message, type),
    sendPlanPrompt: (text, correlationId) =>
      pi.sendMessage(
        {
          customType: RV_PLAN_PROMPT_TYPE,
          content: [{ type: "text", text }],
          display: false,
          details: { correlationId },
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    sendRethinkPrompt: (text, correlationId) =>
      pi.sendMessage(
        {
          customType: RV_PLAN_RETHINK_TYPE,
          content: [{ type: "text", text }],
          display: false,
          details: { correlationId },
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    sendExecutePrompt: (text, correlationId) =>
      pi.sendMessage(
        {
          customType: RV_PLAN_EXECUTE_TYPE,
          content: [{ type: "text", text }],
          display: false,
          details: { correlationId },
        },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    leafEntryId: (ctx) => ctx.sessionManager.getLeafEntry()?.id,
    lastExchange: (ctx) => lastExchangeFromEntries(ctx.sessionManager.getBranch()),
    primaryFamily: (ctx) => (ctx.model ? ctx.models.family(ctx.model) : undefined),
  });

  registerRvCommand(pi, runtime, {
    proceedWithPlan: (ctx, instructions) => activation.proceedWithPlan(ctx, instructions),
    dismissGate: (ctx) => activation.dismissGate(ctx),
    gateDetails: (ctx) => activation.gateDetails(ctx),
    planController,
  });
  registerCouncilAuditTool(pi, runtime);

  const refreshUsage = async (ctx: { model?: { provider: string }; ui: { setStatus(key: string, text: string | undefined): void } }) => {
    if (ctx.model?.provider !== "zai-proxy") {
      ctx.ui.setStatus("rv-glm-usage", undefined);
      return;
    }
    const usage = await fetchGlmUsage();
    ctx.ui.setStatus("rv-glm-usage", compactGlmUsage(usage));
  };

  // OMP 17.1.3 blocking tool_call hook for pre-execution mutation barrier
  pi.on("tool_call", (event, _ctx) => {
    const args = (event as { args?: Record<string, unknown>; input?: Record<string, unknown> }).args ?? (event as { input?: Record<string, unknown> }).input ?? {};
    const res = planController.onToolCall(event.toolName, args);
    if (res.block) {
      return { block: true, reason: res.reason };
    }
  });

  // Fire-and-forget: reviews run in the background; onAgentEnd never throws.
  pi.on("agent_end", (event, ctx) => {
    const leafId = ctx.sessionManager.getLeafEntry()?.id;
    if (planController.isWorkflowTurn(leafId)) {
      void planController.onAgentEnd(event.messages, ctx);
      void refreshUsage(ctx);
      return;
    }

    if (planController.currentState.state === "planning" || planController.currentState.state === "rethinking") {
      void planController.onAgentEnd(event.messages, ctx);
    } else {
      void activation.onAgentEnd(event.messages, ctx);
    }
    void refreshUsage(ctx);
  });

  // Pre-execution planning interception
  pi.on("before_agent_start", (event, _ctx) => {
    const userText =
      event && typeof event === "object" && "message" in event && typeof event.message === "object" && event.message && "content" in event.message
        ? extractMessageText((event.message as any).content)
        : undefined;
    const planResult = planController.onBeforeAgentStart(userText);
    if (planResult) return planResult;

    return activation.onBeforeAgentStart();
  });

  pi.on("session_start", (_event, ctx) => {
    activation.reset();
    planController.reset();
    void refreshUsage(ctx);
    if (runtime.configErrors.length > 0) {
      ctx.ui.notify(
        `RV · config errors in ${runtime.paths.configPath}:\n${runtime.configErrors.join("\n")}`,
        "warning",
      );
    } else if (runtime.config.reviewers.length === 0) {
      ctx.ui.notify(`RV · installed, no reviewers configured — see ${runtime.paths.configPath}`, "info");
    }
  });

  pi.on("session_switch", (_event, ctx) => {
    activation.reset();
    planController.reset();
    void refreshUsage(ctx);
  });
}
