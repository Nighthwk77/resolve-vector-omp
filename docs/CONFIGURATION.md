# Configuration Reference

Resolve Vector reads:

```text
~/.omp/agent/resolve-vector.json
```

Set `RV_CONFIG_PATH` in the environment of one OMP session to point it at an
alternate config (isolated test setups) without touching the live file.
Receipts and the budget ledger stay in the agent directory.

## Top-level settings

| Field | Default | Meaning |
| --- | ---: | --- |
| `mode` | `"manual"` | `off`, `manual`, `auto`, `always`, or `sample` |
| `defaultCouncilMode` | `"review"` | Default operation for model-driven calls |
| `candidateCount` | `3` | Candidate count for ensemble modes |
| `maxRevisionRounds` | `2` | Maximum plan-gate rounds (plan → user-authorized revision → re-review) |
| `sampleRate` | `0.1` | Fraction selected in sample mode |
| `runInBackground` | `true` | Run reviews without opening another interface |
| `allowInteractiveWindows` | `false` | Reserved; keep false for headless behavior |
| `maxExternalAuditsPerHour` | `10` | Shared hourly external-call cap |
| `maxExternalAuditsPerDay` | `50` | Shared daily external-call cap |
| `maxConcurrentReviewers` | `2` | Maximum parallel reviewer calls |
| `connectTimeoutMs` | `10000` | Deadline for connection/first stream event (headers) |
| `firstTokenTimeoutMs` | `10000` | First-meaningful-token deadline for LOCAL reviewers |
| `remoteFirstTokenTimeoutMs` | `30000` | First-meaningful-token deadline for REMOTE reviewers |
| `totalTimeoutMs` | `120000` | Total generation deadline per reviewer call |
| `circuitBreakerCooldownMs` | `300000` | How long a failed seat stays skipped (5 min) |
| `maxReviewInputChars` | `80000` | Review prompt cap; oversized input is truncated with receipt metadata |
| `maxReviewOutputTokens` | `4096` | Max output tokens per reviewer call (repair calls included) |
| `reviewers` | `[]` | Reviewer seat definitions |

## Generation health

Endpoint reachability (`/v1/models`, `/health`) is **not** proof a reviewer
can generate — a wedged server can answer HTTP while producing zero tokens.
RV therefore enforces three deadlines on the real review call itself (never a
pre-review health ping):

1. **connect** — first stream event (headers),
2. **first meaningful token** — real content or `reasoning_content` deltas;
   heartbeats, empty deltas, and metadata events never count,
3. **total** — the whole generation.

A first-token miss aborts the stream, marks the seat `timeout_first_token`,
opens its circuit breaker, and the council continues immediately with healthy
reviewers. Open circuits skip the seat for `circuitBreakerCooldownMs`;
`/rv status` reports the remaining cooldown, and `/rv doctor probe` or
`/rv reviewer retry <id>` runs one half-open probe that closes the circuit on
a successful meaningful completion. When a local seat is unresponsive RV says
so and asks you to restart the model service — RV never kills or restarts
user-managed servers itself.

`/rv status probe`, `/rv doctor probe`, and setup validation can run a tiny
generation probe (fixed trivial prompt, ≤8 output tokens, strict first-token
deadline) that distinguishes `endpoint reachable` from `generation healthy`.

## Reviewer fields

```json
{
  "id": "local-qwen",
  "provider": "vllm-mlx",
  "model": "Qwen3-Coder-Next",
  "family": "qwen",
  "role": "critic",
  "local": true,
  "scope": "local-only",
  "enabled": true,
  "order": 1,
  "trigger": "always"
}
```

| Field | Meaning |
| --- | --- |
| `id` | Stable human-readable seat identifier |
| `provider` | Exact OMP provider ID |
| `model` | Exact OMP model ID |
| `family` | Model family used for diversity enforcement |
| `role` | `critic`, `verifier`, `method`, `judge`, or `fusion` |
| `local` | Whether the endpoint runs on the local machine |
| `scope` | `local-only`, `external-redacted`, or `external-allowed` |
| `enabled` | Whether the seat may run |
| `order` | Stable roster order |
| `trigger` | `always`, `sample`, or reserved `escalation` |

RV checks the live catalog family as well as the configured family. A reviewer
matching the primary family is skipped.

## External budgets

Before every external call, RV atomically reserves one unit in:

```text
~/.omp/agent/resolve-vector.budget.jsonl
```

Reservations are shared across processes. Attempts count even when a call
errors, times out, or needs a repair retry. Local reviewers do not consume the
external budget.

## Receipts

Verdicts are appended to:

```text
~/.omp/agent/resolve-vector.receipts.jsonl
```

Receipts include activation reason, reviewer outcomes, findings, evidence,
latency (connect, first-token, and total), failure category, circuit state,
skip/degradation flags, reported token usage, revision relationship, and
deterministic check results. Secrets are redacted before persistence.

## Privacy scopes

- `local-only`: an external endpoint configured with this scope is blocked.
- `external-redacted`: common API keys, bearer tokens, and similar secrets are
  removed before transport.
- `external-allowed`: raw task content may be sent externally.

Redaction is not anonymization. File structure, prose, domain context, and user
intent may remain identifiable.

## Activation behavior

- `manual` never activates at completion.
- `always` activates for every substantive non-RV completion.
- `auto` uses deterministic signals such as file changes, completion claims,
  diagnoses, recommendations, source reports, and explicit review requests.
- `sample` applies the configured sample rate to otherwise low-risk work.
- `off` disables automatic activation.

RV never reviews its own correction messages, the same leaf entry twice, or
more than `maxRevisionRounds`.
