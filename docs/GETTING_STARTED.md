# Getting Started

This guide takes Resolve Vector from a clean clone to a successful first
cross-model review.

## 1. Before you install

You need:

1. OMP 17.0.7 or newer.
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

1. It lists the models already authenticated in your OMP session and shows
   each candidate's provider, model, family, and local/external endpoint.
2. Models from your primary's family are excluded, with the reason shown —
   cross-family review is the whole point.
3. Local endpoints are detected automatically and default to `local-only`
   (content never leaves the machine). External endpoints default to
   `external-redacted`; sending full unredacted content requires an explicit
   yes at a confirmation prompt.
4. You pick the activation mode (`manual` is recommended initially), review
   the summary — reviewers, content recipients, scopes, budgets, mode — and
   confirm before anything is written.
5. The config is written atomically (existing config backed up first, your
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
machine.

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

## 7. Add a second reviewer

Ensemble commands need at least two enabled reviewer seats. Add another reviewer
entry with a different family, then try:

```text
/rv best 3
/rv fuse 3
/rv compare 3
```

Reviewers are bounded by `maxConcurrentReviewers`, privacy scopes, and the same
external budget ledger.

## 8. Update safely

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
