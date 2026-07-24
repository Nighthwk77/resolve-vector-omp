/**
 * Web bridge core: consultation engine + HTTP API, with the browser context
 * INJECTED so tests drive it with fakes. bridge-entry.mjs supplies the real
 * Playwright context.
 *
 * Consultation rules:
 * - inspect state first; never consult into a login wall or blocked page
 * - popup sweeps: after navigation, before input locate, before submit,
 *   periodically while waiting, once before declaring a stall
 * - never bringToFront — consultations run behind the scenes
 * - one retry maximum, and NEVER retry blocked/login/CAPTCHA/quota states
 * - no secrets in any response: no cookies, no storage, minimal page detail
 */
import http from "node:http";
import { getAdapter, ADAPTERS } from "./adapters.mjs";
import { dismissPopups } from "./popups.mjs";
import { detectState, findInput } from "./detect.mjs";

const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;
const STABLE_POLLS = 3;
const POLL_MS = 2000;

const TRANSIENT_RETRIES = 1; // bounded; blocked/auth states never retry

function cleanResponseText(text, adapter) {
  let cleaned = String(text || "").trim();
  for (const prefix of adapter.stripResponsePrefixes || []) {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i");
    cleaned = cleaned.replace(pattern, "").trim();
  }
  return cleaned;
}

async function readResponses(page, adapter, prompt = "") {
  const selectors = [
    ...adapter.responseSelectors,
    '[data-message-author-role="assistant"]',
    '[data-testid*="assistant"]',
    '[class*="assistant"] [class*="markdown"]',
    'article [class*="markdown"]',
  ];
  for (const sel of [...new Set(selectors)]) {
    try {
      const els = page.locator(sel);
      const n = await els.count();
      if (n > 0) {
        const text = (await els.last().innerText({ timeout: 2000 })).trim();
        if (text) return text;
      }
    } catch (_) {
      /* next */
    }
  }
  return "";
}

async function consultOnce(ctx, app, prompt, options, diag) {
  const adapter = getAdapter(app);
  const host = new URL(adapter.url).host;
  let page = null;
  for (const p of ctx.pages()) {
    try {
      if (new URL(p.url()).host === host && !adapter.newChatPerConsult) {
        page = p;
        break;
      }
    } catch (_) {
      /* about:blank */
    }
  }
  if (!page) page = await ctx.newPage();
  await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Sweep 1: after navigation, then inspect state before anything else.
  diag.popupClicks += await dismissPopups(page, adapter);
  const detected = await detectState(page, adapter);
  diag.sessionState = detected.state;
  if (detected.state !== "ready_authenticated" && detected.state !== "ready_anonymous") {
    const error = new Error(`${app} is not consultable: ${detected.state}${detected.detail ? ` — ${detected.detail}` : ""}`);
    error.category = detected.state === "blocked" ? `blocked_${detected.kind ?? "interstitial"}` : detected.state;
    throw error;
  }

  // Sweep 2: before locating the chat input (a late popup may cover it).
  diag.popupClicks += await dismissPopups(page, adapter);
  let input = await findInput(page, adapter, { settleMs: 5000 });
  if (!input) {
    diag.popupClicks += await dismissPopups(page, adapter);
    input = await findInput(page, adapter, { settleMs: 3000 });
  }
  if (!input) {
    const error = new Error(`no chat input found on ${page.url()} (state was ${detected.state})`);
    error.category = "broken";
    throw error;
  }

  const baseline = await readResponses(page, adapter, prompt);

  // Sweep 3: immediately before submission.
  diag.popupClicks += await dismissPopups(page, adapter);
  input = await findInput(page, adapter, { settleMs: 2000 });
  if (!input) {
    const error = new Error(`chat input disappeared before submission on ${app}`);
    error.category = "interrupted";
    throw error;
  }

  await input.click();
  await page.keyboard.insertText(prompt);
  await page.waitForTimeout(400);
  await page.keyboard.press("Enter");

  const timeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const started = Date.now();
  let last = "";
  let stable = 0;
  let stalledPolls = 0;
  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) {
      const error = new Error("consultation cancelled");
      error.category = "cancelled";
      throw error;
    }
    if (page.isClosed && page.isClosed()) {
      const error = new Error("browser session closed mid-consultation");
      error.category = "session_closed";
      throw error;
    }
    await page.waitForTimeout(pollMs);
    const current = await readResponses(page, adapter, prompt);
    const isNew = current && current !== baseline && !current.includes(prompt.slice(0, 80));
    if (isNew && current === last) {
      stable++;
      if (stable >= STABLE_POLLS) return cleanResponseText(current, adapter);
    } else {
      stable = 0;
    }
    if (!isNew || current === last) stalledPolls++;
    else stalledPolls = 0;
    // Sweep 4: periodically while waiting — mid-conversation interstitials
    // freeze the visible text while generation continues underneath.
    if (stalledPolls >= 4) {
      stalledPolls = 0;
      const cleared = await dismissPopups(page, adapter);
      diag.popupClicks += cleared;
      if (cleared > 0) {
        last = "";
        stable = 0;
      }
    }
    if (isNew) last = current;
    else last = current || last;
  }
  // Sweep 5: once more before declaring a stall.
  diag.popupClicks += await dismissPopups(page, adapter);
  const final = await readResponses(page, adapter, prompt);
  if (final && final !== baseline) return cleanResponseText(final, adapter);
  if (last && last !== baseline) return cleanResponseText(last, adapter);
  const error = new Error(`no response detected within ${timeoutMs / 1000}s on ${app}`);
  error.category = "timeout";
  throw error;
}

export async function consult(ctx, app, prompt, options = {}) {
  const diag = { popupClicks: 0, retries: 0, sessionState: undefined };
  let attempt = 0;
  for (;;) {
    try {
      const text = await consultOnce(ctx, app, prompt, options, diag);
      return { ok: true, text, ...diag };
    } catch (error) {
      const category = error.category ?? "error";
      // Never retry blocked/auth/cancel/broken states; at most one retry for
      // transient transport timeouts. Retrying a selector-drift "broken" page
      // would just re-hit the same unusable state and risk provider noise.
      const retryable = !["blocked_captcha", "blocked_verification", "blocked_rate_limit", "blocked_interstitial", "login_required", "cancelled", "session_closed", "broken"].includes(category);
      if (retryable && attempt < TRANSIENT_RETRIES) {
        attempt++;
        diag.retries = attempt;
        continue;
      }
      return { ok: false, error: error.message, category, ...diag };
    }
  }
}

export function createBridgeServer({ getContext, responseTimeoutMs, port = 3037 }) {
  let lastActivity = Date.now();
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true, bridge: "rv-web-bridge", providers: Object.keys(ADAPTERS), pid: process.pid });
      }
      if (req.method === "POST" && url.pathname === "/state") {
        const { app } = JSON.parse(await readBody(req));
        const ctx = await getContext();
        const adapter = getAdapter(app);
        const page = await ctx.newPage();
        await page.goto(adapter.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const popupClicks = await dismissPopups(page, adapter);
        const detected = await detectState(page, adapter);
        await page.close().catch(() => {});
        return send(200, { app, popupClicks, ...detected });
      }
      if (req.method === "POST" && url.pathname === "/consult") {
        const { app, prompt, timeoutMs } = JSON.parse(await readBody(req));
        if (!prompt || typeof prompt !== "string") return send(400, { ok: false, error: "prompt is required", category: "error" });
        const ctx = await getContext();
        const result = await consult(ctx, app, prompt, { responseTimeoutMs: timeoutMs ?? responseTimeoutMs });
        return send(result.ok ? 200 : 502, result);
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        send(200, { ok: true });
        setTimeout(() => process.exit(0), 100);
        return;
      }
      send(404, { ok: false, error: "unknown endpoint" });
    } catch (error) {
      send(500, { ok: false, error: error.message, category: error.category ?? "error" });
    }
  });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 512_000) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  // Idle self-exit: the bridge never outlives its usefulness.
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > 30 * 60_000) process.exit(0);
  }, 60_000);
  idleTimer.unref();

  return server;
}
