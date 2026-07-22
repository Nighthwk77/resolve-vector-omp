/**
 * Resolve Vector's OMP extension entrypoint.
 * Discovered via the `omp.extensions` entry in package.json.
 */
import { getAgentDir, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerRvCommand } from "./commands.js";
import { defaultPaths, RVRuntime } from "./runtime.js";
import { registerCouncilAuditTool } from "./tool.js";

export default async function resolveVector(pi: ExtensionAPI): Promise<void> {
  const runtime = await RVRuntime.load(defaultPaths(getAgentDir()));
  registerRvCommand(pi, runtime);
  registerCouncilAuditTool(pi, runtime);

  pi.on("session_start", (_event, ctx) => {
    if (runtime.configErrors.length > 0) {
      ctx.ui.notify(
        `RV · config errors in ${runtime.paths.configPath}:\n${runtime.configErrors.join("\n")}`,
        "warning",
      );
    } else if (runtime.config.reviewers.length === 0) {
      ctx.ui.notify(`RV · installed, no reviewers configured — see ${runtime.paths.configPath}`, "info");
    }
  });
}
