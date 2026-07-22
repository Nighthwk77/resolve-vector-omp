/**
 * Resolve Vector's OMP extension entrypoint.
 * Discovered via the `omp.extensions` entry in package.json.
 */
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ActivationController, lastExchangeFromEntries, RV_CORRECTION_TYPE } from "./activation.js";
import { registerRvCommand } from "./commands.js";
import { defaultPaths, RVRuntime } from "./runtime.js";
import { registerCouncilAuditTool } from "./tool.js";

export default async function resolveVector(pi: ExtensionAPI): Promise<void> {
  const runtime = await RVRuntime.load(defaultPaths(getAgentDir()));
  registerRvCommand(pi, runtime);
  registerCouncilAuditTool(pi, runtime);

  const activation = new ActivationController(runtime, {
    notify: (ctx, message, type) => ctx.ui.notify(message, type),
    sendCorrection: (text) =>
      // Hidden corrective turn: the model sees it next turn; the user does not
      // get an editable pending message. triggerTurn schedules the continuation.
      pi.sendMessage(
        { customType: RV_CORRECTION_TYPE, content: [{ type: "text", text }], display: false },
        { deliverAs: "nextTurn", triggerTurn: true },
      ),
    leafEntryId: (ctx) => ctx.sessionManager.getLeafEntry()?.id,
    lastExchange: (ctx) => lastExchangeFromEntries(ctx.sessionManager.getBranch()),
    primaryFamily: (ctx) => (ctx.model ? ctx.models.family(ctx.model) : undefined),
  });

  // Fire-and-forget: reviews run in the background; onAgentEnd never throws.
  pi.on("agent_end", (event, ctx) => {
    void activation.onAgentEnd(event.messages, ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    activation.reset();
    if (runtime.configErrors.length > 0) {
      ctx.ui.notify(
        `RV · config errors in ${runtime.paths.configPath}:\n${runtime.configErrors.join("\n")}`,
        "warning",
      );
    } else if (runtime.config.reviewers.length === 0) {
      ctx.ui.notify(`RV · installed, no reviewers configured — see ${runtime.paths.configPath}`, "info");
    }
  });
  pi.on("session_switch", () => activation.reset());
}
