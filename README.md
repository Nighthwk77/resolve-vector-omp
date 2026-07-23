# Resolve Vector for OMP

Resolve Vector (RV) is a free, open-source, vendor-neutral reasoning and
verification addon for [Oh My Pi](https://github.com/can1357/oh-my-pi) (omp).
It reviews your agent's completed work with a **different model family** —
because same-family models share blind spots, and cross-family reviewers catch
errors the primary model literally cannot see.

Everything runs **headless**: no browser windows, no focused apps, no external
UIs. Reviews appear as compact status lines inside omp.

## What it does

- **review** — one completed answer is challenged by a different-family
  reviewer. You get specific claims challenged, evidence, severity, and a
  suggested correction — not a generic second opinion.
- **best-of-N** (`/rv best`) — N independent candidates are generated in
  isolation (no cross-anchoring), anonymized, shuffled, checked
  deterministically, then scored blind. The judge never learns which model
  wrote which candidate. A candidate that fails an objective check cannot win
  on prose.
- **fuse** (`/rv fuse`) — conflict-aware synthesis: agreements are kept,
  every material conflict is resolved with evidence or left **explicitly
  unresolved**, and the fused answer passes a final independent review.
- **compare** (`/rv compare`) — shows alternatives with tradeoffs and
  unresolved conflicts. Never auto-selects when the choice is yours.

All modes run through the same engine and write durable JSONL receipts.

## Automatic review and the corrective loop

With `mode: "always"` (or `"auto"`/`"sample"`), every substantive completion
is reviewed automatically:

1. The answer is labeled **provisional** while the review runs.
2. `pass` → marked verified.
3. `concern`/`fail` → a hidden corrective message is injected and the primary
   agent revises; the revision is reviewed once more, bounded by
   `maxRevisionRounds`.
4. **`split` means the reviewers disagree and RV takes no side** — the loop
   stops, the competing conclusions are shown, and the decision is yours.
   RV never silently picks a winner or asks the model to revise toward one
   side.
5. Unresolved loops stop and escalate to you.

Loop safety: RV never reviews its own turns, never reviews the same entry
twice, aborts in-flight reviews on session switch, correlates corrective
turns by unique id, and coalesces overlapping completions.

## Privacy

- **Local reviewers are the default posture** — content never leaves the
  machine. The starter config is local-only.
- Every reviewer has a scope: `local-only` (external seats blocked by
  policy), `external-redacted` (secrets redacted before transport — the
  external default), `external-allowed` (full content, explicit trust).
- **Redaction is a mitigation, not a complete privacy boundary.** Context,
  structure, and intent still leak to external endpoints. `/rv status` shows
  exactly which seats receive what.
- External calls are budgeted (`maxExternalAuditsPerHour`/`...Day`), enforced
  by a cross-process ledger, and every attempt counts — including failures
  and retries. Skipped-by-policy seats fail closed and are shown in receipts.

## Install (preview)

```bash
git clone https://github.com/<owner>/resolve-vector-omp.git && cd resolve-vector-omp
npm install
npm run install-preview          # installs into ~/.omp/agent/extensions/
```

Then restart omp and run `/rv doctor`. A fresh install starts in `manual`
mode with **no reviewers** — add a seat from [`examples/`](./examples/)
(local, Kimi, or any OMP provider), then try `/rv review`, or set
`"mode": "always"` in `~/.omp/agent/resolve-vector.json` for automatic
review at completion.

```bash
npm run update-preview           # newer code; your config is never touched
npm run uninstall-preview        # removes the package; config/receipts stay
npm run rollback-preview         # restores the previous install
```

The installer never overwrites an existing `resolve-vector.json`.
Supported omp: **^17.0.7** (peer dependency; `/rv doctor` verifies).

## Configuration

`~/.omp/agent/resolve-vector.json` — the installed starter is
[`resolve-vector.example.json`](./resolve-vector.example.json) (manual mode,
empty roster). Reviewer entries to copy in live under
[`examples/`](./examples/):

- [`examples/local-openai-compatible.json`](./examples/local-openai-compatible.json)
  — a local server (vllm-mlx, Ollama, LM Studio); content never leaves the
  machine.
- [`examples/kimi-external-redacted.json`](./examples/kimi-external-redacted.json)
  — Kimi via OMP's `kimi-code` provider, redacted transport.
- [`examples/omp-provider.json`](./examples/omp-provider.json) — any
  provider/model your omp session can already use.

A reviewer entry looks like:

```json
{
  "id": "my-reviewer",
  "provider": "<omp-provider-id>",
  "model": "<omp-model-id>",
  "family": "<model-family>",
  "role": "critic",
  "local": true,
  "scope": "local-only",
  "enabled": true,
  "order": 1
}
```

`provider`/`model` resolve through omp's own model registry — reviewers use
the same authenticated providers your session already trusts. Find valid ids
with `/model` inside omp or in `~/.omp/agent/models.yml`; `/rv doctor`
verifies every seat. Family diversity is checked live against the model
catalog: a reviewer from the primary model's family is skipped, never
consulted.

## Commands

| Command | What it does |
| --- | --- |
| `/rv review` | Review the last answer with the council |
| `/rv best [n]` / `fuse [n]` / `compare [n]` | Ensemble modes over n candidates |
| `/rv on [auto\|always\|sample]` / `/rv off` | Automatic review at completion (session-scoped) |
| `/rv status` | Mode, roster, content recipients, budget remaining, recent verdicts |
| `/rv doctor` | Actionable health checks (models, credentials, endpoints, paths, privacy, omp version) |
| `/rv config` | Config and receipt file locations |

The model-callable `council_audit` tool exposes the same engine to the agent
itself.

## Troubleshooting

- **No reviewers configured** → copy `resolve-vector.example.json` to
  `~/.omp/agent/resolve-vector.json` and adjust; run `/rv doctor`.
- **`review_unavailable`** → check `/rv status`: seats may be skipped by
  family-diversity, privacy scope, or budget. Reasons are in the receipt.
- **Local endpoint unreachable** → start your local server (vllm-mlx /
  Ollama / LM Studio) and re-run `/rv doctor`.
- **External budget exhausted** → wait for the window or raise the caps;
  usage shows in `/rv status`.

## Preview limitations

- Ensemble deterministic checks are a pipeline hook; the generic profile
  ships no domain checks yet (source-faithfulness is deliberately deferred —
  RV is a general reasoning system, not a porting tool).
- Escalation-trigger seats are parsed but stay cold.
- `auto` activation uses deterministic text/tool signals; it will over- and
  under-fire. Receipts record the firing reason (`activationDetail`) so the
  heuristic can be tuned from real use.
- `/rv on` changes are session-scoped, not persisted.

## Development

```bash
npm install
npm run check   # typecheck
npm test        # bun test
```

The product and engineering specifications are in [`docs/`](./docs/).
