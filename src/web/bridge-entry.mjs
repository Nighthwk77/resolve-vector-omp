#!/usr/bin/env node
/**
 * Web bridge entrypoint (sidecar process). Owns the real Playwright
 * persistent context (bundled Chromium — isolated from the user's Chrome)
 * and serves the bridge HTTP API. Login mode is the ONLY flow allowed to
 * open and intentionally focus a window; normal consultations never
 * bringToFront.
 */
import os from "node:os";
import path from "node:path";
import { getAdapter } from "./adapters.mjs";
import { createBridgeServer } from "./bridge-core.mjs";

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = Number(arg("--port", "3037"));
const PROFILE_DIR = arg("--profile", path.join(os.homedir(), ".omp", "agent", "rv-web-profile"));
const LOGIN_APP = arg("--login", null);

const HEADLESS = LOGIN_APP ? false : !process.argv.includes("--no-headless");

let context = null;

async function getContext() {
  if (context) return context;
  const { chromium } = await import("playwright");
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  context.on("close", () => {
    context = null;
  });
  return context;
}

if (LOGIN_APP) {
  // Interactive login: the user must see and use the window. Focus allowed.
  const adapter = getAdapter(LOGIN_APP);
  const ctx = await getContext();
  const page = await ctx.newPage();
  await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.bringToFront();
  console.log(`[rv-web] ${LOGIN_APP} opened for login at ${adapter.url}`);
  console.log(`[rv-web] log in, then close the window — the profile persists at ${PROFILE_DIR}`);
  await new Promise((resolve) => ctx.on("close", resolve));
  process.exit(0);
}

const server = createBridgeServer({ getContext, port: PORT });
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[rv-web] bridge listening on 127.0.0.1:${PORT} (profile ${PROFILE_DIR})`);
});
