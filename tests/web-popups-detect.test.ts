import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain-JS browser-side module, typed by usage here
import { dismissPopups } from "../src/web/popups.mjs";
// @ts-expect-error — plain-JS browser-side module
import { detectState } from "../src/web/detect.mjs";
import { FakePage } from "./web-fakes.js";

const adapter = { popupCloseSelectors: [], inputSelectors: ["textarea"], responseSelectors: [] };

test("dismissPopups clicks allowlisted buttons and reports the count", async () => {
  const page = new FakePage({
    buttons: [
      { text: "Accept all cookies" },
      { text: "Stay logged out" },
      { text: "Got it" },
      { text: "Random unlisted label" },
    ],
  });
  const clicks = await dismissPopups(page, adapter);
  assert.equal(clicks, 3);
  const buttons = page.options.buttons ?? [];
  assert.equal(buttons[0].clicks, 1);
  assert.equal(buttons[1].clicks, 1);
  assert.equal(buttons[2].clicks, 1);
  assert.equal(buttons[3].clicks, undefined, "unlisted buttons are never clicked");
});

test("dismissPopups never clicks safeguard controls even when text matches", async () => {
  const page = new FakePage({
    buttons: [{ text: "Continue with Google" }, { text: "Continue" }],
    authInputCount: 1, // auth form present: text buttons are off-limits
  });
  const clicks = await dismissPopups(page, adapter);
  assert.equal(clicks, 0);
  assert.equal((page.options.buttons ?? [])[0].clicks, undefined);
  assert.equal((page.options.buttons ?? [])[1].clicks, undefined);
});

test("dismissPopups skips CAPTCHA/verification/paywall/quota controls", async () => {
  const page = new FakePage({
    buttons: [
      { text: "Verify you are human" },
      { text: "Subscribe to continue" },
      { text: "Usage limit reached" },
      { text: "Got it" },
    ],
  });
  const clicks = await dismissPopups(page, adapter);
  assert.equal(clicks, 1, "only the ordinary popup is dismissed");
});

test("detectState: ready_anonymous when a usable input exists without session hints", async () => {
  const page = new FakePage({
    bodyText: "Ask anything\nNew chat",
    inputs: [{ visible: true }],
  });
  const detected = await detectState(page, adapter);
  assert.equal(detected.state, "ready_anonymous");
});

test("detectState: ready_authenticated when input exists and session hints show", async () => {
  const page = new FakePage({
    bodyText: "Ask anything\nMy account\nSign out",
    inputs: [{ visible: true }],
  });
  const detected = await detectState(page, adapter);
  assert.equal(detected.state, "ready_authenticated");
});

test("detectState: login_required on a genuine auth wall with no usable input", async () => {
  const page = new FakePage({
    bodyText: "Welcome back\nContinue with Google\nContinue with email",
    inputs: [],
    authInputCount: 2,
  });
  const detected = await detectState(page, adapter);
  assert.equal(detected.state, "login_required");
});

test("detectState: a header Sign in link on a usable page is NOT a login wall", async () => {
  const page = new FakePage({
    bodyText: "Sign in\nAsk anything and get instant answers\nNew chat",
    inputs: [{ visible: true }],
  });
  const detected = await detectState(page, adapter);
  assert.equal(detected.state, "ready_anonymous", "usable input wins over a stray Sign in link");
});

test("detectState: CAPTCHA and rate limits classify as blocked", async () => {
  const captcha = await detectState(
    new FakePage({ bodyText: "Verify you are human — complete the CAPTCHA below" }),
    adapter,
  );
  assert.equal(captcha.state, "blocked");
  assert.equal(captcha.kind, "captcha");

  const limited = await detectState(new FakePage({ bodyText: "Too many requests — try again later" }), adapter);
  assert.equal(limited.state, "blocked");
  assert.equal(limited.kind, "rate_limit");
});

test("detectState: auth fields are never treated as chat input", async () => {
  const page = new FakePage({
    bodyText: "Welcome",
    inputs: [{ visible: true, isAuth: true }],
    authInputCount: 1,
  });
  const detected = await detectState(page, adapter);
  assert.equal(detected.state, "login_required");
});

test("detectState: broken when nothing recognizable is on the page", async () => {
  const page = new FakePage({ bodyText: "504 Gateway Timeout", inputs: [] });
  const detected = await detectState(page, adapter, { timeoutMs: 50 });
  assert.equal(detected.state, "broken");
});

test("detectState: loading_timeout when page remains un-settled beyond timeoutMs", async () => {
  const page = new FakePage({ bodyText: "loading...", inputs: [] });
  const detected = await detectState(page, adapter, { timeoutMs: 50, pollMs: 10 });
  assert.equal(detected.state, "loading_timeout");
});

test("detectState: prompt cancellation via AbortSignal", async () => {
  const controller = new AbortController();
  controller.abort();
  const page = new FakePage({ bodyText: "loading...", inputs: [] });
  await assert.rejects(
    () => detectState(page, adapter, { timeoutMs: 5000, pollMs: 10, signal: controller.signal }),
    (err: any) => err.category === "cancelled",
  );
});
