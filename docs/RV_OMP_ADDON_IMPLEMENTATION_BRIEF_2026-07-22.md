# Resolve Vector for OMP — implementation brief

**Date:** 2026-07-22  
**Audience:** coding agent or engineer implementing the pivot  
**Status:** approved direction; implement the smallest working vertical slice first

## 1. Product definition

Resolve Vector (RV) is a free, open-source, vendor-neutral reasoning and
verification addon for OMP. It does not replace OMP and is not a standalone
coding agent.

RV can:

1. review one completed answer or action with a different model family;
2. generate multiple independent candidates and choose the best;
3. fuse the strongest compatible parts of multiple candidates;
4. compare candidates without forcing a winner;
5. request an automatic corrective OMP turn when a review finds a material
   concern.

The system must work for reasoning, planning, research, decisions, debugging,
code, and other agent work. Source-faithful port review is the first domain
profile, not the product boundary.

### One-line description

> Resolve Vector is a headless cross-model reasoning and verification layer for
> OMP: review one answer, choose the best of several, or fuse their strongest
> reasoning into a verified result.

## 2. Non-goals

Do not rebuild the former RV application. The MVP must not include:

- an Express server or separate browser SPA;
- a desktop application or focused reviewer windows;
- a competing agent loop, planner, scout, memory system, or patch engine;
- enterprise governance features;
- per-edit cloud calls;
- weighted multi-model voting before a single-reviewer path is proven.

Reuse OMP for sessions, context, tools, providers, models, subagents, and UI.

## 3. Critical OMP API constraint

The installed OMP API distinguishes pre-tool and post-tool hooks:

- `tool_call` fires before execution and may return `{ block: true, reason }`.
- `tool_result` fires after execution and may only replace `content`, `details`,
  or `isError`.

Therefore, **do not implement a post-edit hard gate with `tool_result`**. It
cannot undo or reject an edit that already happened.

Use:

- `agent_end` for automatic reasoning/review activation;
- `tool_call` for true pre-mutation or pre-finalization blocking;
- `tool_result` only for observation, evidence collection, and result
  annotation.

Reference in the installed package:
`dist/types/extensibility/shared-events.d.ts`, `ToolCallEventResult` and
`ToolResultEventResult`.

## 4. Package shape

Create an OMP addon package with this logical layout:

```text
resolve-vector-omp/
  package.json
  README.md
  src/
    index.ts                 # extension entrypoint
    commands.ts              # /rv commands
    tool.ts                  # council_audit model-callable tool
    activation.ts            # agent_end trigger policy and loop guard
    council.ts               # shared runCouncil/runEnsemble engine
    candidates.ts            # independent candidate generation
    judge.ts                 # anonymization, scoring, selection
    fusion.ts                # conflict-aware synthesis
    providers.ts             # OMP/API/local transport adapters
    policy.ts                # mode, budgets, escalation, privacy
    receipts.ts              # JSONL persistence and schemas
    render.ts                # compact OMP-visible status/verdicts
    domain/
      generic.ts             # default reasoning review
      source-faithfulness.ts # optional source comparison profile
  hooks/
    completion-gate.ts       # optional tool_call hard gates
  test/
```

Exact packaging may follow OMP's preferred addon format, but keep the modules
separate enough to test without launching an interactive OMP session.

## 5. Activation design

Registering `council_audit` makes the tool available to the model; it does not
activate it automatically. Automatic activation belongs to the extension.

### Supported activation modes

```ts
type ActivationMode = "off" | "manual" | "auto" | "always" | "sample";
```

- `off`: RV does nothing.
- `manual`: only `/rv review`, `/rv best`, `/rv fuse`, `/rv compare`, or an
  explicit `council_audit` call.
- `always`: review every substantive `agent_end`. Use this while developing.
- `auto`: review when deterministic trigger rules mark the completed work as
  consequential.
- `sample`: review a configured percentage of otherwise low-risk work.

### Automatic completion flow

1. Capture the user goal and relevant turn evidence.
2. Let the primary OMP agent finish normally.
3. On `agent_end`, ignore empty/non-substantive turns and RV-generated review
   turns.
4. Evaluate activation policy.
5. If activated, mark the answer `provisional` and call the council engine
   directly. Do not ask the primary model to remember to call its own reviewer.
6. On `pass`, render and persist a receipt.
7. On `concern` or `fail`, inject a hidden next-turn message:

```ts
pi.sendMessage(message, {
  deliverAs: "nextTurn",
  triggerTurn: true,
});
```

8. The primary agent revises its work using the cited findings.
9. Review the revision once more, bounded by `maxRevisionRounds`.
10. On unresolved disagreement, stop the loop and ask the user.

### Recursion guard

Persist these state fields per session:

```ts
interface ReviewState {
  reviewing: boolean;
  lastReviewedEntryId?: string;
  revisionRound: number;
  reviewTurnIds: string[];
}
```

Never review an RV review message, the same entry twice, or more than the
configured revision limit.

### Auto triggers

Start with `always`. After the vertical slice works, implement `auto` using
cheap deterministic signals:

- files or external state changed;
- the agent made a recommendation or consequential decision;
- the response contains causal, factual, or evidentiary claims;
- the task is diagnosis, planning, research, architecture, security, or audit;
- the agent reports completion;
- a deterministic check failed;
- the user requested review;
- periodic sampling selected the turn.

Do not use model self-confidence as a hard gate.

## 6. User interfaces

### Slash commands

Implement:

```text
/rv status
/rv on [auto|always|sample]
/rv off
/rv review
/rv best [count]
/rv fuse [count]
/rv compare [count]
/rv config
```

### Model-callable tool

Register `council_audit` with a generic schema:

```ts
interface CouncilAuditInput {
  mode: "review" | "best" | "fusion" | "compare";
  goal: string;
  proposal?: string;
  evidence?: EvidenceItem[];
  constraints?: string[];
  candidateCount?: number;
  profile?: "generic" | "source-faithfulness" | string;
}
```

Manual commands, the model-callable tool, and automatic activation must all use
the same internal `runCouncil()` or `runEnsemble()` functions.

## 7. Review and ensemble modes

### Review

One primary result is challenged by at least one different-family reviewer.
Return specific claims challenged, evidence, severity, and a correction—not a
generic second opinion.

### Best-of-N

Generate candidates independently so they do not anchor on each other. Remove
provider/model identity, randomize order, run deterministic checks first, then
score:

- intent satisfaction;
- correctness;
- completeness;
- evidence quality;
- reasoning quality;
- constraint compliance;
- practicality.

The judge must not know which candidate came from which provider. A candidate
that fails an objective check cannot win because it is better written.

### Fusion

Fusion must be conflict-aware, not an average. Extract:

```ts
interface FusionPlan {
  agreements: Claim[];
  conflicts: Conflict[];
  selectedClaims: SelectedClaim[];
  unresolved: Conflict[];
  finalAnswer: string;
}
```

Every material conflict must be resolved with evidence or remain explicitly
unresolved. Run a final independent review on the fused answer.

### Compare

Show meaningful alternatives, strengths, weaknesses, and unresolved conflicts.
Do not select automatically when the choice is subjective or preference-bound.

## 8. Verdict contract

Use a structured result:

```ts
type VerdictStatus = "pass" | "concern" | "fail" | "split" | "insufficient_evidence";

interface CouncilVerdict {
  id: string;
  mode: "review" | "best" | "fusion" | "compare";
  status: VerdictStatus;
  summary: string;
  findings: Finding[];
  selectedCandidateId?: string;
  finalAnswer?: string;
  reviewers: ReviewerReceipt[];
  deterministicChecks: CheckReceipt[];
  usage: UsageReceipt;
  createdAt: string;
}

interface Finding {
  severity: "info" | "low" | "medium" | "high" | "critical";
  category: "intent" | "correctness" | "method" | "assumption" |
    "evidence" | "edge_case" | "constraint" | "security" | "other";
  claim: string;
  concern: string;
  evidence: EvidenceItem[];
  suggestedCorrection?: string;
}
```

Objective contradictions, missing mandatory evidence, and violated constraints
may hard-fail. Subjective reasoning disagreements normally produce `concern`,
`split`, or user escalation.

## 9. Provider and transport requirements

All automatic work must be headless. Never focus or open a browser, desktop app,
or provider window during an automatic review.

Transport order:

1. OMP's configured provider/model mechanism;
2. OpenAI-compatible API, including local endpoints;
3. native vendor API adapter when required;
4. interactive transport only as an explicit manual opt-in, outside the MVP.

Support local and cloud reviewers. Reuse OMP credentials where its public API
allows it; otherwise read only documented environment/config references. Never
copy secrets into RV receipts or logs.

Each configured model needs both endpoint identity and model-family identity:

```ts
interface ReviewerConfig {
  id: string;
  provider: string;
  model: string;
  family: string;
  role: "critic" | "verifier" | "method" | "judge" | "fusion";
  local: boolean;
  enabled: boolean;
  order: number;
  trigger?: "always" | "escalation" | "sample";
}
```

Enforce family diversity, not merely different endpoints. A DeepSeek-family model
served by two providers is not independent family diversity.

### Background behavior

Render compact status without stealing focus:

```text
RV · reviewing with Qwen…
RV · verified
RV · concern found; revision requested
RV · split verdict; user decision needed
RV · external review skipped—budget reached
```

All calls require cancellation, timeouts, concurrency limits, and clear failure
states. If no allowed provider works, return `review_unavailable`; never silently
open a window.

## 10. Configuration

Use one user-owned JSON config, initially `~/.omp/agent/resolve-vector.json`:

```json
{
  "mode": "always",
  "defaultCouncilMode": "review",
  "candidateCount": 3,
  "maxRevisionRounds": 2,
  "sampleRate": 0.1,
  "runInBackground": true,
  "allowInteractiveWindows": false,
  "maxExternalAuditsPerHour": 10,
  "maxExternalAuditsPerDay": 50,
  "maxConcurrentReviewers": 2,
  "reviewers": []
}
```

Validate configuration at startup and display actionable errors. Local reviewers
may run automatically. Before the first paid/cloud automatic review, obtain user
consent and show the configured budget.

## 11. Privacy, cost, and safety

- Provide path/include/exclude controls for evidence sent externally.
- Show which provider receives which material.
- Redact secrets using deterministic patterns before transport and logging.
- Do not log API keys, authorization headers, or raw secret-bearing configs.
- Persist token/request usage when reported by the provider.
- Enforce hourly/daily external call budgets before dispatch.
- A cloud reviewer skipped for policy or budget must be visible, not silently
  replaced.
- Do not let a model judge its own identified candidate.
- Randomize anonymized candidate order to reduce position bias.
- Preserve evidence-backed minority findings even when the majority disagrees.

## 12. Receipts and persistence

Append JSONL receipts under an OMP-compatible user data location. Each receipt
must include:

- session/turn and RV review IDs;
- activation reason;
- mode;
- primary and reviewer model families;
- anonymized candidate IDs;
- findings and evidence references;
- deterministic check outcomes;
- final status and revision relationship;
- latency and reported usage;
- no secrets and no unnecessary full source content.

Provide `/rv status` and `/rv review` output from these receipts without needing a
separate server or database.

## 13. Optional hard gates

Generic reasoning review cannot fully hide the first answer because `agent_end`
occurs after it is produced. Label it `Provisional — RV review running`, then
display the verified/revision state.

For mutations or workflow completion, optional hard gates may use `tool_call`:

- block a commit or "DONE" action while relevant work lacks a passing receipt;
- block protected-path edits and direct the model to an audited custom tool;
- block when mandatory evidence/citations are absent before a protected action.

Do not claim that a `tool_result` hook rolled back an edit.

## 14. Delivery milestones

### Milestone 1 — vertical slice

- One extension file loads through OMP auto-discovery.
- `/rv review` sends the current goal/result to one different-family reviewer.
- Reviewer runs through a local or API headless transport.
- Typed verdict renders in OMP and appends one JSONL receipt.
- No browser/app window opens or receives focus.

### Milestone 2 — automatic revision

- `agent_end` in `always` mode activates review.
- A concern schedules a hidden `nextTurn` corrective message.
- Recursion and revision limits work.
- OMP visibly distinguishes provisional, verified, and unresolved results.

### Milestone 3 — ensemble modes

- `/rv best 3`, `/rv fuse 3`, and `/rv compare 3` work.
- Candidates are independently generated, anonymized, and randomized.
- Objective checks precede model judging.
- Fusion preserves unresolved conflicts.

### Milestone 4 — policy and distribution

- `auto` and `sample` activation work.
- Provider budgets, privacy scopes, cloud consent, and escalation work.
- Package installs into OMP's addon discovery path with documented rollback.
- Public README and examples cover reasoning, planning, research, and code—not
  only source ports.

## 15. Required tests

At minimum, automate:

- extension auto-discovery and command registration;
- `agent_end` activation in every mode;
- no activation recursion;
- bounded revision follow-up using `deliverAs: "nextTurn"`;
- no window/browser launch in automatic paths;
- local OpenAI-compatible reviewer call;
- one cloud API adapter behind consent/budget policy;
- timeout, cancellation, unavailable provider, and rate-limit behavior;
- same-family reviewer rejection;
- candidate anonymization and order randomization;
- deterministic check precedence over judge preference;
- fusion conflict preservation;
- JSONL receipt schema and secret redaction;
- `tool_call` blocking and proof that `tool_result` is not treated as rollback.

## 16. Evaluation before expanding scope

Build a small benchmark containing known reasoning and implementation failures.
Compare:

1. primary model alone;
2. same-family review;
3. different-family review;
4. different-family review plus deterministic evidence checks;
5. best-of-N and fusion where appropriate.

Measure defects caught, false positives, completion quality, latency, and cost.
Do not add weighted councils or complex orchestration until the benchmark shows
incremental value.

## 17. Definition of done for the first public preview

The preview is ready when a user can install the addon, enable `always` mode,
complete a normal reasoning task in OMP, and observe RV run a different-family
review headlessly; a supported concern automatically produces one corrective OMP
turn; the final verdict is visible and persisted; no external window opens; and
the same engine can be invoked manually through `/rv review`.

## 18. Public website deployment requirement

The canonical website is `https://resolvevector.com/`, but
`https://www.resolvevector.com/` must also resolve and permanently redirect to
the canonical apex while preserving the path and query string.

For the current Cloudflare-hosted site, configure this at the Cloudflare zone
level rather than in the Pages `_redirects` file:

1. create a proxied DNS record for `www`;
2. create a 301 redirect from `www.resolvevector.com/*` to
   `https://resolvevector.com/:splat`;
3. preserve query strings and path suffixes;
4. verify both the root and a nested path with `curl -I` after propagation.

Do not serve duplicate content from both hostnames. Keep the apex URL in the
HTML canonical and social metadata.
