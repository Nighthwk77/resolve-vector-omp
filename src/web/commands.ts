/**
 * `/rv web *` commands: optional website-based reviewers through the user's
 * existing browser sessions. Manual-first and off by default — automatic web
 * consultations have real account risk (old RV recorded a DeepSeek
 * suspension), so every path here inspects state before acting and never
 * spams a provider.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { ReviewerConfig } from "../policy.js";
import { ADAPTERS } from "./adapters.mjs";
import { writeConfigAtomic } from "../setup.js";
import type { RVEngine } from "../runtime.js";

const PROVIDER_IDS = Object.keys(ADAPTERS);
const WEB_LABEL = "browser-based · no API key · uses your existing login or free access";

/** Read-merge-write the config atomically, then reload the live runtime. */
async function updateConfig(runtime: RVEngine, mutate: (config: Record<string, unknown>) => void): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(runtime.paths.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  mutate(existing);
  await writeConfigAtomic(runtime.paths.configPath, existing);
  await runtime.reload();
}

function webSeats(config: RVEngine["config"]): ReviewerConfig[] {
  return config.reviewers.filter((r) => r.provider.startsWith("web:"));
}

import { isChromiumInstalled, ensureChromiumInstalled } from "./manager.js";

async function cmdWebSetup(runtime: RVEngine, ctx: ExtensionCommandContext, args: string[] = []): Promise<void> {
  const withWeb = args.includes("--with-web");
  const installed = await isChromiumInstalled();
  if (!installed) {
    if (withWeb) {
      const ok = await ensureChromiumInstalled((msg) => ctx.ui.notify(msg, "info"));
      if (!ok) {
        ctx.ui.notify("RV web setup: failed to install Playwright Chromium — configuration unchanged.", "warning");
        return;
      }
    } else {
      const confirmed = await ctx.ui.confirm(
        "RV web setup: Playwright Chromium browser binary is not installed.",
        "Web reviewers drive an isolated Chromium browser context. Download Chromium now (~150MB)?",
      );
      if (!confirmed) {
        ctx.ui.notify("RV web setup: installation declined — setup aborted, configuration unchanged.", "info");
        return;
      }
      const ok = await ensureChromiumInstalled((msg) => ctx.ui.notify(msg, "info"));
      if (!ok) {
        ctx.ui.notify("RV web setup: Chromium installation failed — configuration unchanged.", "warning");
        return;
      }
    }
  }

  const existing = webSeats(runtime.config);
  const chosen: string[] = [];
  for (;;) {
    const remaining = PROVIDER_IDS.filter((id) => !chosen.includes(id));
    if (remaining.length === 0) break;
    const options = remaining.map((id) => {
      const already = existing.some((r) => r.provider === `web:${id}`);
      return {
        label: `web:${id}`,
        description: `${ADAPTERS[id].url} — ${WEB_LABEL}${already ? " · already configured" : ""}`,
      };
    });
    if (chosen.length > 0) options.push({ label: "Done selecting", description: `${chosen.length} provider(s) chosen` });
    const picked = await ctx.ui.select("RV web setup: add website reviewers (uses your browser logins)", options);
    if (picked === undefined) return; // cancelled — nothing written
    if (picked === "Done selecting") break;
    const id = picked.replace(/^web:/, "");
    if (PROVIDER_IDS.includes(id)) chosen.push(id);
  }
  if (chosen.length === 0) {
    ctx.ui.notify("RV web setup: no providers selected — nothing changed.", "info");
    return;
  }

  const startOrder = Math.max(0, ...runtime.config.reviewers.map((r) => r.order)) + 1;
  await updateConfig(runtime, (config) => {
    const reviewers = Array.isArray(config.reviewers) ? (config.reviewers as ReviewerConfig[]) : [];
    // Never silently overwrite an existing roster: replace only OUR web seats
    // for the chosen providers, keep everything else byte-identical.
    const kept = reviewers.filter((r) => !chosen.includes(r.provider.replace(/^web:/, "")));
    const added = chosen.map((id, index) => ({
      id: `web-${id}`,
      provider: `web:${id}`,
      model: id,
      family: ADAPTERS[id].family,
      role: index === 0 ? ("critic" as const) : ("verifier" as const),
      local: false,
      scope: "external-redacted" as const,
      enabled: true,
      order: startOrder + index,
    }));
    config.reviewers = [...kept, ...added];
  });

  // Inspect each new provider's real state (no consultation, just detection).
  const lines = [`RV web setup: ${chosen.length} provider(s) configured.`];
  for (const id of chosen) {
    try {
      const detected = await runtime.web.bridge.detectState(id);
      lines.push(`  web:${id} — ${detected.state}${detected.kind ? ` (${detected.kind})` : ""}`);
      if (detected.state === "login_required") lines.push(`    → log in once: /rv web login ${id}`);
    } catch (error) {
      lines.push(`  web:${id} — state check failed: ${(error as Error).message}`);
    }
  }
  lines.push("Web consultations stay OFF until you opt in: /rv web on");
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdWebStatus(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
  const lines: string[] = [];
  const bridge = await runtime.web.bridge.status();
  lines.push(`bridge: ${bridge.running ? `running on 127.0.0.1:${bridge.port}` : `not running (${bridge.error ?? "idle"})`}`);
  lines.push(`web consultations: ${runtime.config.webAdvisors.optIn ? "OPTED IN" : "off (default)"} · cooldown ${runtime.config.webAdvisors.cooldownMs / 1000}s per provider`);
  const seats = webSeats(runtime.config);
  if (seats.length === 0) {
    lines.push("no web providers configured — /rv web setup to add some");
  }
  for (const seat of seats) {
    const app = seat.provider.replace(/^web:/, "");
    try {
      const detected = await runtime.web.bridge.detectState(app);
      lines.push(`  ${seat.id}: ${detected.state}${detected.kind ? ` (${detected.kind})` : ""} · popup sweeps ${detected.popupClicks}`);
      if (detected.state === "login_required") lines.push(`    → /rv web login ${app}`);
    } catch (error) {
      lines.push(`  ${seat.id}: state check failed — ${(error as Error).message}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function cmdWebLogin(runtime: RVEngine, ctx: ExtensionCommandContext, provider: string | undefined): Promise<void> {
  if (!provider || !PROVIDER_IDS.includes(provider)) {
    ctx.ui.notify(`RV · usage: /rv web login <${PROVIDER_IDS.join("|")}>`, "warning");
    return;
  }
  // Login is the ONLY flow allowed to open and focus a browser window.
  const entryPath = new URL("./bridge-entry.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [entryPath, "--login", provider], { detached: true, stdio: "ignore" });
  child.unref();
  ctx.ui.notify(
    `RV · ${provider} opened in a browser window for login. Sign in there, then close the window — the session persists in the RV profile. Then run /rv web status to verify.`,
    "info",
  );
}

async function cmdWebTest(runtime: RVEngine, ctx: ExtensionCommandContext, provider: string | undefined): Promise<void> {
  if (!provider || !PROVIDER_IDS.includes(provider)) {
    ctx.ui.notify(`RV · usage: /rv web test <${PROVIDER_IDS.join("|")}>`, "warning");
    return;
  }
  // A manual test IS the user's explicit consent for one consultation.
  ctx.ui.notify(`RV · inspecting web:${provider} first…`, "info");
  try {
    const detected = await runtime.web.bridge.detectState(provider);
    if (detected.state === "login_required") {
      ctx.ui.notify(`RV · web:${provider} requires login — run /rv web login ${provider} first.`, "warning");
      return;
    }
    if (detected.state === "blocked" || detected.state === "broken") {
      ctx.ui.notify(`RV · web:${provider} is ${detected.state}${detected.kind ? ` (${detected.kind})` : ""} — not consulting. ${detected.detail ?? ""}`, "warning");
      return;
    }
    ctx.ui.notify(`RV · state ${detected.state} — one consultation, no retries…`, "info");
    const result = await runtime.web.bridge.consult(provider, "Reply with exactly: RV-OK", 90_000);
    if (result.ok) {
      ctx.ui.notify(
        `RV · web:${provider} responded (${result.sessionState}, popups ${result.popupClicks}, retries ${result.retries}):\n${(result.text ?? "").slice(0, 400)}`,
        "info",
      );
    } else {
      ctx.ui.notify(`RV · web:${provider} consultation failed [${result.category}]: ${result.error}`, "warning");
    }
  } catch (error) {
    ctx.ui.notify(`RV · web:${provider} failed: ${(error as Error).message}`, "warning");
  }
}

async function cmdWebOn(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
  if (webSeats(runtime.config).length === 0) {
    ctx.ui.notify("RV · no web providers configured — run /rv web setup first.", "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "RV web: enable website consultations?",
    "Web reviewers drive real browser sessions on your logged-in websites. Providers have suspended accounts for automation before (old RV: DeepSeek). RV mitigates this with: manual-first design, 1-at-a-time consultations, per-provider cooldowns, and no retries of blocked pages. Enable?",
  );
  if (!confirmed) return;
  await updateConfig(runtime, (config) => {
    config.webAdvisors = { ...(typeof config.webAdvisors === "object" && config.webAdvisors !== null ? config.webAdvisors : {}), optIn: true };
  });
  ctx.ui.notify("RV · web consultations enabled (opted in). /rv web off to disable.", "info");
}

async function cmdWebOff(runtime: RVEngine, ctx: ExtensionCommandContext): Promise<void> {
  await updateConfig(runtime, (config) => {
    config.webAdvisors = { ...(typeof config.webAdvisors === "object" && config.webAdvisors !== null ? config.webAdvisors : {}), optIn: false };
  });
  ctx.ui.notify("RV · web consultations disabled.", "info");
}

export async function dispatchWeb(runtime: RVEngine, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "setup":
      return cmdWebSetup(runtime, ctx, args);
    case "status":
      return cmdWebStatus(runtime, ctx);
    case "login":
      return cmdWebLogin(runtime, ctx, args[0]);
    case "test":
      return cmdWebTest(runtime, ctx, args[0]);
    case "on":
      return cmdWebOn(runtime, ctx);
    case "off":
      return cmdWebOff(runtime, ctx);
    default:
      ctx.ui.notify("RV · usage: /rv web setup|status|login <provider>|test <provider>|on|off", "warning");
  }
}
