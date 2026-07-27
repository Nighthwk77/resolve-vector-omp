# Getting Started

This guide takes Resolve Vector from a clean clone to a successful first
cross-model review.

## 1. Before you install

You need:

1. OMP 17.0.7 or newer (minimum API level). This release is validated against
   OMP 17.1.6; use the current OMP release for a new installation.
2. Node.js and npm.
3. A primary model in OMP.
4. A reviewer from a different family.

Different endpoints are not enough. Two Qwen models are still the same family;
RV will skip the reviewer rather than pretend that is independent verification.

Inside OMP, run `/model` to see the exact provider and model IDs currently
available.

## 2. Install the addon

```bash
git clone https://github.com/Nighthwk77/resolve-vector-omp.git
cd resolve-vector-omp
npm install
npm run install-preview
```

The installer copies RV to `~/.omp/agent/extensions/resolve-vector-omp` and
creates `~/.omp/agent/resolve-vector.json` only when it does not already exist.

## 3. Run the setup wizard

Restart OMP and run:

```text
/rv setup
```

The wizard is the normal path — no JSON editing, no models.yml inspection:

1. It lists the models already authenticated in your OMP session and, when
   Chromium is installed, scans all supported browser advisors. A browser
   advisor appears only when its page is usable through a saved login or
   anonymous access; login walls, blocked pages, and broken pages are excluded.
2. Models from your primary's family are excluded, with the reason shown —
   cross-family review is the whole point.
3. You independently select exactly which and how many reviewers check
   completed work/issues and which check plans before OMP edits. A reviewer
   may be selected for one workflow or both.
4. Local endpoints are detected automatically and default to `local-only`
   (content never leaves the machine). External endpoints default to
   `external-redacted`; sending full unredacted content requires an explicit
   yes at a confirmation prompt.
5. You pick separate completion and plan modes (`manual` and `ask` are
   recommended initially), review the summary — workflow rosters, content
   recipients, scopes, budgets, and modes — and confirm before anything is
   written. Selecting a browser advisor here explicitly enables web
   consultations; selecting none keeps them off.
6. The config is written atomically (existing config backed up first, your
   unrelated settings preserved), the runtime reloads without a restart, and
   the wizard finishes with the same checks `/rv doctor` runs.

Cancel at any prompt and nothing is written.

### Advanced: configure by hand

If you prefer editing JSON (or script your setups), copy one of the examples
and adjust it:

```bash
cp examples/kimi-external-redacted.json ~/.omp/agent/resolve-vector.json   # Kimi, redacted
cp examples/local-openai-compatible.json ~/.omp/agent/resolve-vector.json  # local server
cp examples/omp-provider.json ~/.omp/agent/resolve-vector.json             # any OMP provider
```

Replace every `<placeholder>` with real values — `/model` inside OMP shows
valid provider/model IDs, and local servers answer `curl
http://127.0.0.1:8001/v1/models`. For cloud providers, keep `scope:
"external-redacted"` until you have made an explicit decision to allow full
content. Local seats use `scope: "local-only"` and send nothing off the
machine. Add `"workflows": ["completion_review"]` or
`"workflows": ["plan_review"]` to restrict a seat; omit `workflows` to use a
legacy seat for both.

## 4. Validate before reviewing

The wizard already ran doctor's checks as its last step. If you configured by
hand (or want to re-verify later), run:

```text
/rv doctor
/rv status
```

Doctor checks that the extension loaded, the model resolves, credentials exist,
local endpoints respond, receipt paths are writable, privacy policy is clear,
and the external budget has room.

Do not proceed past a failed model, credential, or endpoint check.

## 5. Run the first review

Keep `mode: "manual"` initially. Ask the primary model to perform a real task,
then run:

```text
/rv review
```

RV shows a compact verdict and writes the complete receipt to:

```text
~/.omp/agent/resolve-vector.receipts.jsonl
```

## 6. Turn on automatic checking

After manual review works, edit `~/.omp/agent/resolve-vector.json`:

```json
{
  "mode": "auto"
}
```

`auto` reviews consequential completions. Use `always` when you want every
substantive completion checked. Start with conservative external budgets.

Session-only switches are also available:

```text
/rv on auto
/rv on always
/rv off
```

## 7. Enable pre-execution planning

Completion checking and plan checking are separate controls. Start the planner
in `ask` mode so RV checks OMP's approach before edits and always waits for
your approval:

```text
/rv plan ask
```

Give OMP a consequential task such as an implementation, fix, refactor,
configuration change, or deployment. OMP may inspect files, but RV blocks
mutating tools until:

1. OMP proposes a plan;
2. the `plan_review` council checks it;
3. OMP addresses any findings and RV checks the revised plan; and
4. you run `/rv proceed` or give approval in ordinary language.

Use `/rv revise <instructions>` or type guidance to change the plan, `/rv
details` to see the plan and findings, and `/rv dismiss` to cancel without
editing anything.

After ask mode is proven in your setup, `/rv plan auto` may execute a passed
low-risk plan without another prompt. It still stops on split or unavailable
reviews, unresolved findings, destructive intent, configured external
effects, and configured high-severity findings. These command changes last for
the current OMP session; `/rv setup` persists your chosen plan mode.

Plan-review seats and completion-review seats are selected independently in
`/rv setup`. A seat can serve either workflow or both. The completion mode
still independently decides whether RV reviews the finished implementation.

See [Planner Workflow](PLANNER.md) for the exact behavior and limitations.

## 8. Add a second reviewer

Ensemble commands need at least two enabled reviewer seats. Add another reviewer
entry with a different family, then try:

```text
/rv best 3
/rv fuse 3
/rv compare 3
```

Reviewers are bounded by `maxConcurrentReviewers`, privacy scopes, and the same
external budget ledger.

## 9. Update safely

```bash
cd resolve-vector-omp
git pull
npm run update-preview
```

Update makes a backup of the installed addon and never touches your config.
If the new build misbehaves:

```bash
npm run rollback-preview
```


To remove the addon while preserving your config and receipts:

```bash
npm run uninstall-preview
```

## 10. Optional: website-based reviewers

In addition to API-backed reviewers, RV can add a reviewer seat for a
provider's **website** — driven through a real Chromium session that reuses
your existing login or free access. This covers providers with no API tier
and is **off by default**.

Because aggressive automation has caused provider account suspensions
before, this path is manual-first and conservative: every consultation
inspects the page state first, never types into login or auth fields, runs
popup sweeps at five points, and never retries blocked/CAPTCHA/usage-limit
pages. The browser stays headless except for the one-time `login` step.

If you skipped the `--with-web` flag at install time, install the browser now:

```bash
node scripts/install.mjs install --with-web
```

Then inside OMP:

```text
/rv web setup
/rv web login kimi
/rv web test kimi
/rv web on
```

`/rv web setup` adds `web:<provider>` seats to your roster (default scope
`external-redacted`). The main `/rv setup` wizard also discovers every
supported site that is currently `ready_authenticated` or `ready_anonymous`
and lets you assign it separately to plan or completion/issue review.
`/rv web status` shows the live detected state for each provider on your
machine. Web seats feed the same verdict parser, repair loop, and council
merge as API reviewers — there is no second engine.

See the README's "Web-based reviewers" section for the full safety contract.
