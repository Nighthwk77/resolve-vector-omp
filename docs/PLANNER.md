# Pre-execution Planner

Resolve Vector's planner checks OMP's intended approach before consequential
work begins. It is separate from completion review: planning evaluates what
OMP intends to do; completion review evaluates what OMP actually delivered.

## Quick start

Run the setup wizard and assign at least one cross-family reviewer to planning:

```text
/rv setup
```

Start with:

```text
/rv plan ask
```

Then give OMP an implementation, fix, refactor, configuration, publishing, or
other consequential task.

## Actual workflow

```text
User task
  → deterministic activation
  → OMP inspects and writes a plan (mutations locked)
  → plan_review council checks the plan
      → concern/fail: OMP rethinks → council checks again (bounded)
      → split/unavailable/unresolved: stop for the user
      → pass in ask mode: stop for the user
      → safe pass in auto mode: begin execution
  → OMP executes (mutations unlocked)
  → completion activation policy independently decides whether to review result
```

The primary OMP model owns both the plan and the implementation. RV supplies
independent findings and controls the gate; it does not silently replace OMP's
plan with its own.

## Modes

Planner mode is independent of completion-review mode:

| Planner mode | Behavior |
| --- | --- |
| `off` | No pre-execution interception |
| `ask` | Review plans and always wait for the user before execution |
| `auto` | Execute only a passed plan that clears deterministic escalation checks |

Commands change the current session:

```text
/rv plan ask
/rv plan auto
/rv plan off
/rv plan status
/rv plan details
```

`/rv setup` persists the chosen mode to
`~/.omp/agent/resolve-vector.json`.

The separate `planning.activation` setting controls which user turns enter the
planner:

| Activation | Behavior |
| --- | --- |
| `auto` | Consequential change requests selected by deterministic keywords |
| `always` | Every non-greeting user turn |
| `manual` | Accepted for compatibility but non-activating in this preview |

There is currently no one-shot `/rv plan start` command. If `auto` misses tasks
you want planned, use `always`; if that is too broad, return to `auto`.

## Mutation barrier

During plan authoring, council review, rethink, revision review, and the user
decision:

- recognized file reads, searches, directory inspection, and read-only shell
  diagnostics are allowed;
- edit/write tools and mutating shell commands are blocked;
- unknown tools fail closed because RV cannot prove they are read-only.

The barrier is enforced by OMP's blocking `tool_call` hook. A prompt also tells
OMP to plan first, but safety does not depend on the model obeying that text.
The lock opens only for an accepted execution turn or when planning is
disabled/cancelled.

## Review and rethink behavior

Only enabled seats assigned to `plan_review` participate. A seat without a
`workflows` field participates in both planning and completion review for
backward compatibility.

Plan reviews reuse the normal council engine, including:

- live cross-family enforcement;
- local/external privacy scopes and secret redaction;
- external-call budgets;
- generation deadlines and circuit breakers;
- API, local, and explicitly opted-in web reviewers;
- structured findings and JSONL receipts.

A `concern` or `fail` sends concise structured findings back to OMP. OMP must
return a complete revised plan, and RV reviews that revision again. The loop is
bounded by `planning.maxRethinkRounds` (default `2`). The current safety path
always checks revised plans; `reviewRevisedPlan` remains accepted only for
configuration compatibility.

## User decisions

In `ask` mode, every pass pauses before execution. The panel says that no files
have changed and offers:

```text
/rv proceed
/rv revise <instructions>
/rv details
/rv dismiss
```

Typing ordinary guidance while the panel is active also requests a revised
plan. Simple approval phrases such as “yes,” “proceed,” “go ahead,” or “do it”
approve it.

In `auto` mode, RV still stops when:

- reviewers split or review is unavailable;
- findings remain after the rethink limit;
- a nominal pass contains configured high/critical findings;
- destructive intent is detected;
- configured external effects are detected.

These checks use conservative deterministic patterns. They reduce accidental
execution but do not infer every possible side effect or expand the authority
granted by the user.

## Completion review

Accepted execution does not itself mean “verified.” When execution ends, the
normal completion policy independently applies:

- `manual`: run `/rv review` yourself;
- `auto`: review consequential completions;
- `always`: review every substantive completion;
- `sample`: review the configured sample;
- `off`: do not review automatically.

Planning, rethink, and internal RV continuation turns are marked so completion
review does not mistake them for finished implementation.

## Current preview limits

- Consequential-task detection is keyword-based and can over- or under-fire.
- Shell classification intentionally blocks ambiguous commands.
- `planning.activation: "manual"` has no one-shot starter yet.
- `reviewRevisedPlan: false` does not bypass revision review.
- `askOnSplit: false` does not permit auto-selection; split is always terminal
  for user choice.
- Plan receipts currently record workflow, activation reason, plan mode,
  rethink round, and correlation ID. They do not persist hidden reasoning.

Use `/rv plan status`, `/rv plan details`, and `/rv status` to inspect the
current workflow, verdicts, reviewer scopes, budgets, and circuit state.
