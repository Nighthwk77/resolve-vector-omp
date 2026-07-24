/**
 * Popup dismissal, ported and hardened from old RV's scripts/advisor-bridge.js.
 *
 * CONSERVATIVE ALLOWLIST: button text must match POPUP_BUTTON_RE exactly
 * (anchored) so auth actions like "Continue with Google" are never clicked.
 * When auth inputs are present in a scope, only textless X-close buttons are
 * used there — never text buttons like "Continue"/"OK"/"Done".
 *
 * NEVER dismissed: CAPTCHAs, authentication, email/identity verification,
 * paywalls, provider usage limits, security safeguards. Unknown overlays are
 * left alone and surface through detection/diagnostics instead of
 * uncontrolled clicking.
 *
 * Fail-soft everywhere: every failure is swallowed; the click count is
 * returned for diagnostics.
 */
export const POPUP_BUTTON_RE =
  /^(continue|continue without accepting|accept(\s+all)?(\s+cookies)?|allow all|agree|i agree|got it|understood|ok(ay)?|stay logged out|no thanks|not now|maybe later|dismiss|skip( tour)?|close|done)$/i;

export const POPUP_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="Dismiss"]',
  '[aria-label*="close" i]',
  '[title="Close"]',
  '[data-testid*="close" i]',
  '[class*="modal"] button[class*="close" i]',
  '[role="dialog"] button[aria-label*="close" i]',
];

/** Text patterns that mark a control as a provider safeguard — never clickable. */
export const SAFEGUARD_RE =
  /captcha|verify (you|your|it|email|identity|phone)|verification|sign in|log ?in|continue with|passkey|password|magic link|subscribe|upgrade|paywall|payment|billing|usage limit|rate limit|quota/i;

export async function hasAuthInputs(scope) {
  try {
    return (
      (await scope
        .locator(
          'input[type="email"], input[type="password"], input[type="tel"], input[autocomplete="username"], input[autocomplete="current-password"], input[autocomplete="tel"]',
        )
        .count()) > 0
    );
  } catch (_) {
    return false;
  }
}

/**
 * Sweep visible popups across the page and its frames.
 * Returns the number of elements dismissed (0 = nothing touched).
 */
export async function dismissPopups(page, adapter = {}) {
  let clicks = 0;
  let scopes = [page];
  try {
    scopes = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  } catch (_) {
    /* frames unavailable — main page only */
  }
  for (let pass = 0; pass < 4 && clicks < 6; pass++) {
    let acted = false;
    for (const scope of scopes) {
      const authInputsPresent = await hasAuthInputs(scope);
      // Textless X buttons first — closing a modal is safe even on auth pages.
      for (const sel of [...(adapter.popupCloseSelectors || []), ...POPUP_CLOSE_SELECTORS]) {
        if (clicks >= 6) break;
        try {
          const el = scope.locator(sel).first();
          if (await el.isVisible({ timeout: 250 })) {
            await el.click({ timeout: 1000 });
            clicks++;
            acted = true;
            await page.waitForTimeout(250);
          }
        } catch (_) {
          /* fail-soft */
        }
      }
      let buttons = [];
      try {
        buttons = await scope.locator('button, [role="button"]').all();
      } catch (_) {
        /* none */
      }
      for (const b of buttons) {
        if (clicks >= 6) break;
        try {
          if (!(await b.isVisible({ timeout: 200 }))) continue;
          const text = ((await b.innerText({ timeout: 300 })) || "").trim();
          if (!text || text.length > 32) continue;
          // Safeguards are never clicked, even if the allowlist regex matches.
          if (SAFEGUARD_RE.test(text)) continue;
          if (!POPUP_BUTTON_RE.test(text)) continue;
          // On auth pages, text buttons like Continue/OK/Done are off-limits.
          if (authInputsPresent && /^(continue|agree|i agree|ok(ay)?|done)$/i.test(text)) continue;
          await b.click({ timeout: 1000 });
          clicks++;
          acted = true;
          await page.waitForTimeout(350);
        } catch (_) {
          /* stale/hidden — next */
        }
      }
    }
    if (!acted) break;
  }
  return clicks;
}
