# Resolve Vector for OMP

[![CI](https://github.com/Nighthwk77/resolve-vector-omp/actions/workflows/ci.yml/badge.svg)](https://github.com/Nighthwk77/resolve-vector-omp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A second model that checks the first one.**

Resolve Vector (RV) is a free, vendor-neutral verification addon for
[Oh My Pi](https://github.com/can1357/oh-my-pi). OMP does the work; RV asks a
different model family to challenge the result, catch blind spots, and request
a bounded correction when something material is wrong.

No extra app. No focused browser windows. Reviews run headlessly inside OMP.

## Why use it?

A model is often least reliable when reviewing its own reasoning. RV makes
cross-vendor checking automatic:

- GLM can be checked by Qwen or Kimi.
- Kimi can be checked by GLM or a local model.
- Local work can stay entirely on your machine.
- Disagreement is shown as a split; RV never hides it or picks a side for you.
- Every review leaves an inspectable JSONL receipt.

RV works on code, debugging, plans, research, recommendations, audits, and
general reasoning. It is not limited to source ports.

## Install

You need OMP 17.0.7 or newer, Node/npm, and at least two different model
families available to OMP.

```bash
git clone https://github.com/Nighthwk77/resolve-vector-omp.git
cd resolve-vector-omp
npm install
npm run install-preview
```

For the optional website-based reviewers (Chromium-driven), add `--with-web`:

```bash
node scripts/install.mjs install --with-web
```

This installs the Playwright Chromium browser (~150 MB). Without it, web
reviewers stay inert until `/rv web setup` installs the browser on demand.
```

Restart OMP, then run:

```text
/rv setup
```

The native wizard lists your authenticated models (provider, model, family,
local/external), excludes same-family candidates with reasons, detects local
endpoints, defaults external seats to redacted transport, and writes the
config atomically after a review page — no JSON editing required. It finishes
with `/rv doctor`'s checks and reloads the runtime, so no second restart is
needed.

The safe starter configuration is manual with no reviewers, so installation
never starts sending your work to another provider unexpectedly.

## Get to the first review

`/rv setup` is the primary path. After it completes, ask your primary model to
complete a task, then run:

```text
/rv review
```

Prefer editing JSON? Copy a starter from [`examples/`](examples/) instead
(local server, Kimi external-redacted, or any OMP provider) — see the
*Advanced: configure by hand* section in
**[Getting Started](docs/GETTING_STARTED.md)**.

The reviewer must be a different model family from the primary. The wizard
enforces this; by hand, use a local or generic-provider example when your
primary is Kimi.

## What you see

```text
RV · review started — Qwen + Kimi
RV · verified · rv-mry4u50r-1
```

or, when a material problem is found:

```text
RV · FAIL — 1 finding — remediation plan requested (round 1/2)
━━━ Resolve Vector review verdict: FAIL ━━━
…findings, reviewer seats, receipt id…
<the primary model's plan-only remediation turn, shown as normal output>
RV · awaiting your decision — /rv proceed · /rv revise <instructions> · /rv dismiss · /rv details
```

RV never corrects autonomously. On `concern`/`fail` it shows the verdict and
findings, asks the primary model for ONE plan-only turn (no edits, no
mutating tools), displays the plan, and stops. Execution happens only when
you choose it: `/rv proceed` runs the plan, `/rv revise <instructions>` runs
it with your steering, `/rv dismiss` closes the review, `/rv details`
reprints the verdict and plan. Ordinary text typed at the gate counts as
steering — the findings and pending plan are attached to that turn.

A user-authorized revision is reviewed exactly once. If it still fails, RV
produces a fresh plan and pauses again, bounded by `maxRevisionRounds`;
unresolved results stop and return control to you. A `pass`/`fail`
disagreement becomes `split`: both sides shown, no side taken, no plan.

## Modes

| Mode | Behavior |
| --- | --- |
| `manual` | RV runs only when you request it. Safe default. |
| `auto` | Reviews consequential completions selected by deterministic signals. |
| `always` | Reviews every substantive completion. Best for dogfooding. |
| `sample` | Reviews a configured sample of otherwise low-risk turns. |
| `off` | Disables automatic review. Manual commands remain available. |

Set the persistent mode in `~/.omp/agent/resolve-vector.json`, or change it for
the current session with `/rv on auto`, `/rv on always`, or `/rv off`.

## Commands

| Command | What it does |
| --- | --- |
| `/rv review` | Challenge the last answer with the reviewer council |
| `/rv best [n]` | Generate independent candidates and select the checked winner |
| `/rv fuse [n]` | Build a conflict-aware synthesis, then review it |
| `/rv compare [n]` | Show alternatives without forcing a winner |
| `/rv status [probe]` | Show mode, reviewers, circuit state, budgets, and recent verdicts; `probe` adds a tiny generation-health check |
| `/rv usage` | Show GLM/Z.ai quota when the local proxy is configured |
| `/rv setup` | Native wizard: reviewers, privacy scopes, activation mode, atomic write |
| `/rv doctor [probe]` | Check models, credentials, endpoints, paths, privacy, and OMP version; `probe` proves generation health, not just reachability |
| `/rv reviewer retry <id>` | One half-open probe of a circuit-broken reviewer; closes the circuit on success |
| `/rv on [auto\|always\|sample]` | Enable automatic review for this session |
| `/rv off` | Disable automatic review for this session |
| `/rv config` | Show configuration and receipt locations |
| `/rv web setup` | Add website-based reviewers that drive a real Chromium session on a provider's site through your existing login |
| `/rv web status` | Show the bridge process, opt-in state, per-provider cooldown, and detected page state for each configured web reviewer |
| `/rv web login <provider>` | Open the provider's site in a visible browser window so you can sign in once; the session persists in an RV-only profile |
| `/rv web test <provider>` | Run exactly one consultation (`Reply with exactly: RV-OK`) to verify the bridge works, after inspecting page state |
| `/rv web on` / `/rv web off` | Opt web consultations into/out of the reviewer council (off by default) |

The model-callable `council_audit` tool uses the same review engine.

## Privacy and cost

Each reviewer has an explicit scope:

| Scope | Meaning |
| --- | --- |
| `local-only` | Content must stay on the machine; external seats are blocked. |
| `external-redacted` | Secrets are stripped before transport. This reduces risk but is not a complete privacy boundary. |
| `external-allowed` | Full content may be sent to an endpoint you explicitly trust. |

External calls are limited by hourly and daily budgets. Reservations are atomic
across OMP processes, and failed calls and repair retries still count. `/rv
status` tells you exactly which endpoint receives what.

## Web-based reviewers (optional, opt-in)

Besides API-backed reviewers, RV can add a reviewer seat for a provider's
**website** itself — driven through a real Chromium session that reuses your
existing login or free access. This covers providers with no API tier.

**Safety by design.** Prior automation experiments got accounts suspended, so
this feature is manual-first and conservative:

- **Off by default.** No web consultation happens unless you run `/rv web on`.
- **Inspect before acting.** Every consultation first detects the page state:
  `ready_authenticated`, `ready_anonymous`, `login_required`, `blocked`, or
  `broken`. A stray "Sign in" header link on a usable page is **not** a login
  wall — RV proceeds. A login wall short-circuits with no typing.
- **Never types into auth fields** (login, email, password, verification, OTP).
  The Consultation prompt only ever goes into a recognized chat input.
- **Popup sweeps** run at five points (post-navigation, pre-input-locate,
  pre-submit, periodically while waiting, and before declaring a stall). A
  conservative allowlist is the only set of buttons ever clicked; CAPTCHA,
  verification, paywall, and quota controls are **never** dismissed.
- **No retries of blocked states** — CAPTCHA, verification, rate-limit, and
  login pages are reported once and never retried. Only transient transport
  timeouts retry, at most once.
- **Concurrency 1** across all web consultations (one browser profile), with a
  per-provider cooldown (default 60 s) to avoid hammering a site.
- **Headless by default.** The only flow that ever focuses the browser window
  is `/rv web login <provider>`, so you can complete a sign-in once; the
  session persists in an RV-only profile (`~/.omp/agent/rv-web-profile`).
- **No secrets in responses.** Receipts record `transport: "interactive_web"`
  plus a failure category, session state, popup-click count, and retry count —
  never cookies, tokens, or page HTML.

Web reviewers feed the **same** verdict parser, repair loop, council merge, and
cross-family checks as API reviewers — there is no second review engine. They
sit at `local: false` with the default `external-redacted` scope, so the budget
ledger, redaction, and fail-closed machinery apply unchanged. A web seat is a
`web:<provider>` provider (e.g. `web:deepseek`) and bypasses the model
registry/API-key path entirely.

**One-time setup:**

```text
/rv web setup      # pick providers and add seats to the config
/rv web login kimi  # sign in once (opens a visible window)
/rv web test kimi   # verify one consultation returns RV-OK
/rv web on          # opt web reviewers into the council
```

Supported providers: deepseek, chatgpt, gemini, perplexity, claude, kimi, glm.
Live-tested status varies by site; run `/rv web status` to see the detected
state for each on your machine.

## Ensembles

- **Best-of-N** generates candidates independently, removes provider identity,
  shuffles them, runs deterministic checks first, and judges blind.
- **Fusion** records agreements and conflicts. Unresolved conflicts remain
  visible instead of being averaged away.
- **Compare** presents meaningful alternatives and leaves subjective decisions
  to you.
- A `pass`/`fail` reviewer disagreement becomes `split`; no automatic
  correction is triggered, no plan is requested — you decide.

## Update, rollback, and uninstall

From the cloned repository:

```bash
git pull
npm run update-preview       # preserves your configuration
npm run rollback-preview     # restores the previous installed build
npm run uninstall-preview    # preserves config, receipts, and budget history
```

The installer never overwrites a configured reviewer roster.

## Troubleshooting

- **No reviewers configured:** choose an example and copy it to
  `~/.omp/agent/resolve-vector.json`.
- **Reviewer does not resolve:** open `/model` in OMP, copy the exact provider
  and model IDs, then run `/rv doctor`.
- **`review_unavailable`:** `/rv status` shows whether family diversity,
  privacy policy, endpoint health, or budget blocked the seat.
- **Reviewer generation unresponsive (endpoint answers but no tokens):** RV
  aborts at the first-token deadline (~10s local), opens the seat's circuit
  for five minutes, and continues with healthy reviewers. Restart the model
  service (e.g. vllm-mlx), then run `/rv doctor probe` or
  `/rv reviewer retry <id>` to close the circuit. RV never restarts
  user-managed servers itself.
- **Local endpoint unreachable:** start vLLM, vllm-mlx, Ollama, or LM Studio,
  then rerun `/rv doctor`.
- **External budget exhausted:** wait for the window or adjust the configured
  hourly/daily limits.
- **Need more detail:** see [Getting Started](docs/GETTING_STARTED.md) and
  [Configuration Reference](docs/CONFIGURATION.md).

## Current preview limits

- Generic deterministic checks are still a pipeline hook rather than a large
  built-in rule library.
- Escalation-trigger reviewer seats are parsed but remain inactive.
- `auto` mode is heuristic and will sometimes over- or under-fire.
- `/rv on` changes are session-scoped; edit the JSON config to persist a mode.
- Web-based reviewers are new and opt-in: site selectors can drift as
  providers update their UIs, and a provider may change or revoke access at
  any time. Run `/rv web status` and `/rv web test <provider>` to verify a
  site is still usable on your machine before relying on it. Aggressive
  auto-consults caused a provider suspension in a prior experiment — keep web
  reviewers off unless you need them, and never bypass a CAPTCHA, login wall,
  or usage limit.

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

CI typechecks, runs the full unit/integration suite, and performs a real
pack/install/update/rollback/uninstall smoke on Linux.

MIT licensed. Contributions and issue reports are welcome.
