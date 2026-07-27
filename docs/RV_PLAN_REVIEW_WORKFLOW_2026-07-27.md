# Resolve Vector Plan Review Workflow

**Status:** implementation brief  
**Date:** 2026-07-27  
**Repository:** `resolve-vector-omp`

## Purpose

Resolve Vector currently reviews an OMP agent's answer after the agent finishes
working. That catches bad results, but it can discover a bad direction only
after files were edited and time was spent implementing it.

Add a pre-execution plan workflow in which:

1. OMP proposes a plan before using mutating tools.
2. RV's independent reviewers critique that plan.
3. OMP rethinks its own plan using the reviewers' concerns and ideas.
4. RV checks the revised plan.
5. The accepted plan either waits for the user or executes automatically,
   according to an explicit setting.
6. The existing post-completion RV review still verifies the implementation.

RV is an advisor and gate in this workflow. The primary OMP model remains
responsible for understanding the task, choosing the implementation, and doing
the work.

## User experience

### Ask mode

```text
User gives OMP a consequential task
        ↓
OMP researches as needed and proposes a plan only
        ↓
RV reviews the plan
        ↓
OMP revises the plan using RV's criticism
        ↓
RV checks the revised plan
        ↓
RV explains the decision in plain English and waits
        ↓
User approves, steers, or cancels
        ↓
OMP executes
        ↓
Existing RV completion review runs
```

### Auto mode

```text
User gives OMP a consequential task
        ↓
OMP proposes a plan
        ↓
RV critiques it
        ↓
OMP rethinks it
        ↓
RV accepts the revised plan
        ↓
OMP executes automatically
        ↓
Existing RV completion review runs
```

Auto mode interrupts the user only when RV and OMP cannot safely settle the
plan, the reviewers disagree materially, or the work needs authority the user
has not granted.

### Visible progress

RV must keep the user oriented without exposing hidden chain-of-thought:

```text
RV · checking OMP's plan
RV · 2 concerns found — asking OMP to rethink the plan
RV · checking the revised plan
RV · revised plan accepted — OMP starting work
RV · checking completed work
RV · verified
```

These messages describe state and decisions, not private model reasoning.

## Commands and configuration

Commands:

```text
/rv plan ask       # automatically review consequential plans; ask before execution
/rv plan auto      # automatically review and execute accepted low-risk plans
/rv plan off       # disable pre-execution plan review
/rv plan status    # show mode, current state, rounds, and pending decision
/rv plan details   # show the plan, concerns, and revised plan
```

Suggested configuration:

```json
{
  "planning": {
    "mode": "ask",
    "activation": "auto",
    "maxRethinkRounds": 2,
    "reviewRevisedPlan": true,
    "askOnSplit": true,
    "askOnCritical": true,
    "askOnExternalEffects": true
  }
}
```

Defaults must be conservative:

- Existing installations default to `planning.mode: "off"` during rollout.
- New setup may recommend `ask`, but must not silently enable auto-execution.
- `/rv setup` explains which tasks trigger planning and whether accepted plans
  execute automatically.
- Mode changes through commands are session-scoped unless the user explicitly
  persists them.

## Activation

Plan review must happen before mutation, so post-completion `agent_end`
activation is too late. Use OMP's lifecycle in two stages:

1. At `before_agent_start`, classify the submitted task using deterministic
   consequence signals.
2. During a planning turn, use OMP's blocking `tool_call` hook as a hard safety
   net for mutating tools.

Auto activation should cover:

- requests to implement, fix, refactor, migrate, install, configure, publish,
  deploy, or otherwise change state;
- tasks likely to modify files;
- multi-file or architectural work;
- consequential debugging where the proposed fix will mutate code;
- external actions such as commits, pushes, deployments, messages, purchases,
  account changes, or infrastructure changes.

It should bypass greetings, questions, explanations, read-only inspection, and
other trivial/non-mutating requests. `/rv plan` can explicitly start planning
when deterministic activation does not fire.

Activation must not rely on the primary model claiming confidence.

## Mutation barrier

During `planning`, `reviewingPlan`, `rethinking`, `reviewingRevision`, and
`awaitingUser`, block mutating tool calls through OMP's `tool_call` event.

At minimum, block:

- `edit` and `write`;
- mutating `bash` commands;
- custom tools declared or configured as mutating;
- Git commit/push and release/publish operations;
- external writes, messages, deployments, or account changes.

Allow read-only research needed to form a useful plan:

- file reads, grep, glob, and directory inspection;
- non-mutating diagnostics;
- documentation and web research;
- safe status and diff commands.

Do not rely only on a prompt telling the model not to edit. The hook must
actually block mutation and return a clear tool error:

```text
RV plan review is active. This turn may inspect and plan, but it cannot change
files or external state. Finish the plan first.
```

Shell classification must fail closed when a command cannot confidently be
classified as read-only. Keep the classifier small, testable, and
configuration-extensible.

## State machine

Add a dedicated `PlanController`; do not overload the existing completion
`ActivationController`.

```text
idle
  → planning
  → reviewingPlan
  → rethinking
  → reviewingRevision
  → accepted
      → awaitingUser   (ask mode or escalation)
      → executing      (auto mode, safe and authorized)
  → completionReview  (existing ActivationController)
  → done
```

Terminal or exceptional paths:

```text
reviewingPlan/reviewingRevision
  → split              → awaitingUser
  → reviewUnavailable  → awaitingUser
  → unresolved         → awaitingUser
  → cancelled          → idle
```

Required state includes:

- session generation token;
- original user goal;
- original plan;
- each structured review verdict;
- revised plan;
- current rethink round;
- exact OMP entry IDs owned by the workflow;
- whether mutation is locked;
- user authorization, if granted;
- execution correlation ID;
- final completion-review receipt ID.

Session switch, branch switch, cancellation, or abort invalidates the old
generation and releases no queued execution into a new session.

## OMP and RV collaboration

### Initial plan request

The primary OMP model receives the original task plus a hidden instruction:

```text
Before changing files or external state, inspect what you need and produce a
concise implementation plan. State the intended outcome, affected components,
important risks, validation, and any decision that genuinely requires the
user. Do not implement during this turn.
```

The plan is shown normally to the user. Hidden prompts are tagged so RV never
mistakes its own planning turns for ordinary completions.

### RV plan review

Run the plan through the existing council infrastructure:

- enforce different model families;
- reuse scopes, redaction, budgets, timeouts, circuits, and receipts;
- accept API, local, and opted-in web reviewer seats;
- do not create a second review engine.

The plan-review prompt should evaluate:

- whether the plan actually satisfies the user's intent;
- missing requirements and likely edge cases;
- incorrect assumptions about the repository or runtime;
- unnecessary complexity;
- safety and reversibility;
- testing and concrete completion evidence;
- sequencing and efficient use of OMP steps;
- whether the plan requests user input only for a real decision.

Review output remains structured, but feedback sent to OMP contains concise
claims, concerns, and suggested changes—not reviewer identity or hidden
reasoning.

### Rethink turn

On `concern` or `fail`, RV sends the findings back to the primary OMP model:

```text
Resolve Vector found the following concerns with your proposed plan:
<structured findings>

Rethink the plan. Address every concern or rebut it with concrete evidence.
Return a complete revised plan, not a patch or commentary on the old plan.
Do not implement anything during this turn.
```

OMP owns the revised plan. RV must not silently synthesize a replacement and
pretend it came from the primary model.

Review the revised plan again when `reviewRevisedPlan` is enabled. Bound the
loop with `maxRethinkRounds`; never permit reviewer/model debate to continue
indefinitely.

## Acceptance and escalation

In `ask` mode, every accepted plan waits for the user.

In `auto` mode, execute only when:

- the final plan-review verdict is `pass`;
- no reviewer reports a critical finding;
- no material split exists;
- the action remains inside authority already granted by the user's request;
- the plan does not include destructive or externally consequential work that
  requires confirmation;
- the rethink-round limit has not been exhausted;
- the session and correlation IDs still match.

Always ask the user for:

- a `split` verdict;
- unresolved critical findings;
- destructive operations;
- publishing, deployment, messaging, purchases, account changes, or other
  external side effects without explicit prior authorization;
- material product choices not inferable from the request;
- review unavailability when proceeding would be risky.

Auto mode reduces routine interruptions; it does not expand user authority.

## Clear user decision UI

Do not make the user decode this:

```text
RV · awaiting your decision — /rv proceed · /rv revise · /rv dismiss
```

Present a plain-language panel:

```text
Resolve Vector reviewed OMP's plan.

RV found 2 issues. OMP revised the plan to address them.
No files have been changed yet.

What should OMP do?

▶ Approve and start work
  Change the plan
  Show review details
  Cancel this work
```

For an unresolved plan:

```text
Resolve Vector and OMP could not settle one decision.

They disagree about:
Whether the migration should preserve the old configuration format.

No files have been changed yet.

What should OMP do?

▶ Preserve compatibility
  Use the new format only
  Tell OMP another approach
  Cancel this work
```

Requirements:

- explain what happened in plain English;
- state whether files or external state have changed;
- summarize the actual decision, not merely the verdict label;
- explain what each choice does;
- provide a safe default;
- accept ordinary typed steering as “Change the plan”;
- retain slash commands as shortcuts, not as the only interface;
- never display internal names such as `correctionId`, `pendingPlan`, “gate,”
  or “revision round” to the user;
- keep detailed reviewer findings available through “Show review details.”

If OMP's UI cannot open a selector safely from an event callback, render the
same panel as a visible message and accept natural-language steering plus
commands. Do not regress to a bare list of cryptic commands.

## Interaction with completion review

Plan acceptance is not final verification. After execution:

1. OMP finishes the implementation and emits `agent_end`.
2. RV's existing completion `ActivationController` reviews the actual result.
3. A pass ends the workflow as verified.
4. A concern/fail follows the existing remediation flow.
5. In plan-auto mode, post-completion correction may also be automated only if
   a separate explicit policy enables it. Do not infer that permission merely
   from automatic plan execution.

Planning turns, plan-review turns, and rethink turns must be marked so the
completion activation policy never reviews them as completed implementation.

## Receipts

Extend receipts without breaking existing readers. Record:

- `workflow: "plan_review"`;
- plan mode and activation reason;
- hashes or bounded snapshots of original and revised plans;
- each plan-review verdict ID;
- rethink round count;
- acceptance source: `user`, `auto_policy`, or `dismissed`;
- escalation reason when applicable;
- whether execution began;
- correlated completion-review receipt ID.

Never record hidden reasoning, credentials, cookies, or unredacted external
payloads.

## Failure behavior

- Reviewer unavailable: do not label the plan accepted. In ask mode, explain
  the limitation; in auto mode, escalate rather than execute risky work.
- Primary model fails to produce a plan: retry once with a stricter format,
  then return control to the user.
- Primary attempts mutation during planning: block the tool, preserve the
  planning state, and tell it to finish the plan.
- Session changes: abort review calls and discard pending execution.
- Duplicate events: entry and correlation IDs make all transitions
  idempotent.
- New user input while reviewing: treat it as steering if correlated;
  otherwise cancel or supersede the stale plan visibly.
- Budget exhaustion: surface which reviewers were skipped and do not pretend
  that an unreviewed plan passed.

## Testing requirements

Unit tests:

- auto activation and trivial-task bypass;
- every state transition;
- mutating tool calls blocked in every pre-execution state;
- read-only tools remain available;
- unknown shell/custom tools fail closed;
- reviewer criticism reaches the primary model;
- revised plan is a complete OMP-authored plan;
- pass in ask mode waits;
- pass in auto mode executes;
- split, critical, unavailable, destructive, and external actions escalate;
- rethink rounds are bounded;
- natural-language steering carries plan and findings;
- workflow-owned turns never trigger completion review;
- session reset aborts stale review and execution;
- duplicate events do not execute twice;
- receipts correlate plan and completion reviews;
- existing completion-review tests remain green.

Live smoke:

1. Use a disposable repository.
2. Ask OMP for a small, clearly mutating change.
3. Confirm no file changes occur during initial planning or rethink.
4. Force one reviewer concern and prove OMP revises the plan.
5. In ask mode, prove nothing changes until approval.
6. Approve and prove OMP executes the revised plan.
7. Prove the existing completion review runs afterward.
8. Repeat in auto mode and prove a passing low-risk plan proceeds without a
   user interruption.
9. Force a split or critical finding and prove auto mode stops for the user.

## Definition of done

This feature is complete only when:

- a consequential task can be intercepted before its first mutation;
- the mutation barrier is enforced by OMP's blocking hook;
- RV critiques the plan and OMP visibly rethinks it;
- ask mode presents a clear, non-cryptic decision;
- auto mode executes only a passed, safe, authorized revised plan;
- split/unresolved/high-risk cases stop for the user;
- completion review still verifies the actual implementation;
- tests and live smokes prove no pre-approval edits and no duplicate execution;
- setup, configuration, README, and command help document the feature.

