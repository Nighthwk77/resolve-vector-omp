/**
 * Page state detection for web providers. ALWAYS inspect before acting:
 * a usable chat input means we proceed without any login flow; only a
 * genuine auth wall reports login_required. A "Sign in" link in a header on
 * an otherwise usable page is NOT a login wall.
 *
 * States:
 * - ready_authenticated: usable chat input + evidence of a logged-in session
 * - ready_anonymous: usable chat input, no auth evidence, no auth wall
 * - login_required: auth wall present AND no usable chat input
 * - blocked: CAPTCHA / verification / rate limit / quota / interstitial
 * - broken: expected page controls cannot be found
 */
import { hasAuthInputs } from "./popups.mjs";

export const BLOCK_RE =
  /captcha|are you a robot|verify you are human|verify your (email|identity|phone)|unusual traffic|too many requests|rate limit|usage limit|quota exceeded|try again later|access denied|temporarily blocked/i;

/** Strong auth-wall signals: evaluated only when no usable input exists. */
export const AUTH_WALL_RE =
  /sign in to continue|log in to continue|continue with google|continue with email|create an account|sign up to continue|temporary sign-in link|check your email|magic link|welcome back/i;

/** Weak signals that do NOT prove a wall on their own (header Sign in links etc). */
export const SESSION_HINT_RE = /sign out|log out|my account|account settings|upgrade to|pro plan|subscription/i;

export const ANY_INPUT_SELECTOR = '[role="textbox"], [contenteditable="true"], textarea';

export async function findInput(page, adapter, { settleMs = 20_000 } = {}) {
  try {
    await page.locator(ANY_INPUT_SELECTOR).first().waitFor({ state: "visible", timeout: settleMs });
  } catch (_) {
    /* fall through — site selectors may still match */
  }
  for (const sel of [...adapter.inputSelectors, '[role="textbox"]', '[contenteditable="true"]', "textarea"]) {
    const el = page.locator(sel).last();
    try {
      if (await el.isVisible({ timeout: 1500 })) return el;
    } catch (_) {
      /* next */
    }
  }
  return null;
}

async function bodyText(page, limit = 6000) {
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return String(text).slice(0, limit);
  } catch (_) {
    return "";
  }
}

/**
 * Auth-field typing guard: an input is unusable if it IS or sits beside
 * login/email/password/verification fields. Never type a consultation into
 * those.
 */
export async function inputIsAuthField(page, input) {
  try {
    const attrs = await input.evaluate(
      (el) => `${el.tagName}:${el.getAttribute("type") || ""}:${el.getAttribute("placeholder") || ""}:${el.getAttribute("name") || ""}`,
    );
    if (/email|phone|password|tel|username|verification|otp/i.test(attrs)) return true;
  } catch (_) {
    /* fall through to page-level check */
  }
  return hasAuthInputs(page);
}

/**
 * Detect the provider's current state. Popups should already have been swept
 * once by the caller (post-navigation) before this runs.
 */
export async function detectState(page, adapter) {
  const text = await bodyText(page);

  // Hard blocks first: CAPTCHA/verification/quota walls own the page.
  if (BLOCK_RE.test(text)) {
    const kind = /captcha|robot|unusual traffic|verify you are human/i.test(text)
      ? "captcha"
      : /verify your (email|identity|phone)/i.test(text)
        ? "verification"
        : /rate limit|too many requests|usage limit|quota|try again later/i.test(text)
          ? "rate_limit"
          : "interstitial";
    return { state: "blocked", kind, detail: text.slice(0, 200) };
  }

  const input = await findInput(page, adapter, { settleMs: 8000 });
  if (input) {
    if (await inputIsAuthField(page, input)) {
      return { state: "login_required", detail: "only auth fields are present" };
    }
    const authenticated = SESSION_HINT_RE.test(text) && !/^\s*sign in\s*$/im.test(text);
    return { state: authenticated ? "ready_authenticated" : "ready_anonymous" };
  }

  // No usable input: is it a genuine auth wall or selector drift?
  if (AUTH_WALL_RE.test(text) || (await hasAuthInputs(page))) {
    return { state: "login_required", detail: text.slice(0, 200) };
  }
  return { state: "broken", detail: `no chat input and no recognized wall on ${page.url()}` };
}
