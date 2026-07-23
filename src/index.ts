/**
 * Resolve Vector's OMP extension entrypoint.
 * Discovered via the `omp.extensions` entry in package.json.
 */
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ActivationController, lastExchangeFromEntries, RV_CORRECTION_TYPE, RV_PLAN_TYPE } from "./activation.js";
import { registerRvCommand } from "./commands.js";
import { defaultPaths, RVRuntime } from "./runtime.js";
import { registerCouncilAuditTool } from "./tool.js";
import { compactGlmUsage, fetchGlmUsage } from "./provider-usage.js";

export default async function resolveVector(pi: ExtensionAPI): Promise<void> {
  const runtime = await RVRuntime.load(defaultPaths(getAgentDir()));

  const activation = new ActivationController(runtime, {
    notify: (ctx, message, type) => ctx.ui.notify(message, type),
    sendCorrection: (text, correctionId) =>
      // Hidden corrective turn: the model sees it next turn; the user does not
      // get an editable pending message. triggerTurn schedules the continuation.
      // The unique correctionId tags the turn so only IT can consume the
      // pending revision state.
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
      // Hidden plan-request turn: plan-only prompt; the plan renders as the
      // model's normal answer; its completion opens the user gate.
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

  registerRvCommand(pi, runtime, activation);
  registerCouncilAuditTool(pi, runtime);

  const refreshUsage = async (ctx: { model?: { provider: string }; ui: { setStatus(key: string, text: string | undefined): void } }) => {
    if (ctx.model?.provider !== "zai-proxy") {
      ctx.ui.setStatus("rv-glm-usage", undefined);
      return;
    }
    const usage = await fetchGlmUsage();
    ctx.ui.setStatus("rv-glm-usage", compactGlmUsage(usage));
  };

  // Fire-and-forget: reviews run in the background; onAgentEnd never throws.
  pi.on("agent_end", (event, ctx) => {
    void activation.onAgentEnd(event.messages, ctx);
    void refreshUsage(ctx);
  });
  // Ordinary user text at the plan gate gets findings + pending plan attached.
  pi.on("before_agent_start", (_event, _ctx) => activation.onBeforeAgentStart());
  pi.on("session_start", (_event, ctx) => {
    activation.reset();
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
    void refreshUsage(ctx);
  });
}
