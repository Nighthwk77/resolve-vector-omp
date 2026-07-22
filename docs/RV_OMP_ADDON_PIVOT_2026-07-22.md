# RV → free omp addon (pivot) — 2026-07-22

## Decision
Stop building RV as a standalone app competing with omp. **Pivot RV to a free
omp addon: a cross-vendor "advisor council" / port-audit layer.** Keep the RV
name. Ship it free (open-source), not as a product.

### Why this pivot (no-bullshit version)
- On raw coding-agent capability RV can't beat omp (team + community + Rust core +
  benchmaxxed). Competing there is a losing race.
- The market for a standalone "auditable agent" is enterprise-governance-shaped
  (SIEM, SSO, policy gateways, EU AI Act) — a funded company, not a solo app. And
  same-model review is already commoditized (Claude Code Review = 9 parallel
  **Claude** sub-agents; CodeRabbit/Greptile; $2–3B market).
- **RV's one true differentiator: cross-VENDOR review.** Same-model councils share
  blind spots. GLM/DeepSeek/Claude/GPT have different failure modes, so they catch
  each other's errors. The incumbents structurally *won't* do this — Anthropic
  won't route review to GPT; OpenAI won't route to Claude. A vendor-neutral
  cross-check is only ever built by a neutral third party.
- That differentiator is **addon-shaped, not app-shaped** (the Friend-of-Me
  Claude↔Codex bridge is ~100 lines of free MCP — proof it's a feature, not a
  company). So build it as a free omp addon, where it's cheap, cross-cutting, and
  immediately useful to the SimC port.
- Bonus: it directly serves our own work — GLM ports a symbol in omp, a
  *different-vendor* model audits the port against the cited C++ `file:line`.
  That's the CLAUDE.md faithfulness rule, enforced by a model that doesn't share
  GLM's blind spots.

### What survives from RV, what's dropped
- **Survives:** the "deterministic gate / verify outside the model" thesis, and
  the cross-vendor council. Both become omp addon pieces.
- **Dropped:** the standalone app, the Express server, the browser SPA, the
  competing-harness ambition.

---

## omp mechanisms this is built on (verified in the installed pkg)
omp is extensible three ways; all support **auto-discovery** by dropping a `.ts`
file in a directory (no rebuild):

1. **Hooks** — `~/.omp/agent/hooks/*.ts` (or `--hook`). API:
   `import type { HookAPI } from "@oh-my-pi/pi-coding-agent/hooks"`.
   `pi.on("tool_call" | "tool_result", async (event, ctx) => {…})` and can
   **`return { block: true, reason }`** to gate a tool call. Also
   `pi.registerCommand(...)`. → this is the **deterministic gate** (fires whether
   or not the model chooses to).
2. **Extensions** — `~/.omp/agent/extensions/*.ts` (or `--extension`). Register
   custom tools (`createTool`/`registerTool`), slash commands, **`systemPromptAppend`**
   (dynamically modify the system prompt), and **subagents** (isolated-context
   delegates — the natural home for each reviewer model).
3. **Skills** — `SKILL.md` with **autoload** (omp surfaces a skill when its
   description matches the context) + `skill://` + manual `/`-invocation.
4. **Rules** — `AGENTS.md`/project rules, which omp reads on first run. (Proven:
   GLM already checks the C++ source unprompted because our CLAUDE.md/AGENTS.md
   tells it to.)

---

## How to make the AI use it automatically (three tiers)
From softest/easiest to hardest/guaranteed. Ship tier 1+3; tier 2 optional.

**Tier 1 — model-driven (easy, not guaranteed).** An AGENTS.md rule +/or an
autoloading SKILL.md: *"After porting or editing a `simc_port` symbol, call the
`council_audit` tool with the changed file and the cited C++ `file:line`."* The
model follows this the same way it already follows the "check the C++" rule.
Cheap, but the model can skip it under pressure.

**Tier 2 — system-prompt append (medium).** An extension using
`systemPromptAppend` to always inject the council instruction, so it survives
compaction and doesn't depend on file discovery.

**Tier 3 — deterministic hook (guaranteed — the RV thesis).** A hook on
`tool_result` for `edit`/`write` targeting `Theorycrafted/simc_port/**`:
automatically fire the cross-vendor audit **outside the model's discretion**. If a
reviewer flags a faithfulness mismatch, `return { block: true, reason: <the
disagreement + cited C++ lines> }` so the change is rejected/looped back. The
model literally cannot bank an unverified port. This is RV's "deterministic gate
outside the model" — now ~50–100 lines of omp hook instead of an app.

> Recommended: **Tier 3 for enforcement + Tier 1 for the model's own hygiene.**
> Deterministic where it matters, cooperative where it helps.

---

## Cross-vendor providers already available
The council needs genuinely different model families. We already have, or can add,
in `~/.omp/agent/models.yml`:
- `zai-proxy` → **GLM 5.2 / 5.1** (via local retry proxy) — the porter.
- `vllm-mlx` → **Qwen3-Coder-Next** (local) — cheap reviewer.
- `nvidia` (NIM) → **Nemotron / other NIM coding models** — different family.
- add **DeepSeek** and **Anthropic** presets for max blind-spot diversity.
Rule of thumb: the auditor must be a *different vendor* than the porter (GLM ports
→ DeepSeek/Claude/Nemotron audits), never GLM-audits-GLM.

---

## Council design (decisions)

### It reviews method, not just correctness
Deterministic gates (DPS delta, coefficient match, compile) only catch wrong
*outputs*. They're blind to **right-answer-wrong-method** — a port that nets the
correct PvE DPS via a misread control flow, a mis-modeled proc/condition, or a
coefficient that matches only the tested case. Those pass every numeric check and
are still wrong. **This is the council's core reason to exist:** a different-vendor
advisor reasoning about the *approach* catches the method error a test cannot.
Critical for our actual goal — adapting the sim to **PvP/different situations** —
because a method flaw hides behind a passing PvE test and only detonates when the
situation changes. So the council corrects the *method to the end*, not just the end.

Implication: **method review can't be gated on output signals** (a passing DPS
delta won't reveal a method flaw). Method-review advisors run on the *approach*
(new-symbol / how-it's-modeled) and on a periodic sample — not only on result diffs.

### Provider-agnostic + local-first (works for everybody, ban-safe)
Local reviewers only work for users with the hardware, so the addon must not
assume them:
- Uses whatever the user has in their omp config. **Local reviewers if present**
  (free, unlimited — for us: DeepSeek V4 via DS4, Qwen via mlx, GLM), **cloud if
  that's all they have.**
- **Never hardwire an external call per edit** — that gets you rate-limited/banned
  (DeepSeek did exactly this to us when hardwired). External calls are rare,
  budgeted, and batched.
- `maxExternalAuditsPerHour` (and per-day) budget knob; the addon throttles/queues
  to respect it. Ban-safety is a config value, not a hazard.

### Trigger tiers (cheap free signals gate expensive reviews)
Fire order, cheapest first; each tier decides whether the next is worth spending:
1. **Deterministic domain signals (primary, free, most trustworthy):** diff
   touches a coefficient/damage/scaling number; compile/smoke fails; cited C++
   `file:line` missing/vague; **DPS delta vs the C++ reference exceeds threshold**
   (near-ground-truth — this is the real confidence meter, not model self-report).
2. **Model-confidence signals (secondary, weak):** logprobs/perplexity if the
   provider exposes them; self-reported confidence. Caveat: models are
   overconfident and confidently wrong — use as a cheap filter, never the gate.
3. **Batch, don't per-edit:** audit at `git commit` / symbol-complete
   (`port_progress.log` DONE), coalescing that batch into one review.
4. **Escalation:** cheap **local** cross-vendor review always (when triggered);
   escalate to **external cloud** only on local-reviewer *disagreement* or a
   periodic sample.

### User-defined advisor roster (ordered + role-typed)
The council is a roster the user fully owns — not a fixed pipeline. Each advisor:
`{ provider/model, role, trigger, weight, order }`.
- **role** — correctness/coefficient checker · **method/approach reviewer** ·
  idiomatic/edge-case reviewer. Different concerns → different advisors.
- **order** — drives the escalation chain (cheap/local first) *and* tiebreak
  authority when advisors split.
- **trigger** — per-advisor (coefficient checker on numeric diffs; method reviewer
  on new-symbol/sample; external ones only on escalation/budget).
- **weight** — how much each opinion counts in the merged verdict.
- Rule preserved: **the auditor must be a different vendor than the porter**
  (GLM ports → DeepSeek/Nemotron/Claude audits), never GLM-audits-GLM.
- This also *is* the "works for everybody" answer: local users order local
  reviewers first; cloud-only users set tight triggers/budgets and fewer advisors.

## Build on omp's native advisor role (don't build orchestration from scratch)

omp already ships the multi-model machinery. Verified primitives in the installed
pkg (`settings-schema.d.ts`, roles, subagents):
- **Roles → models:** `default/smol/slow/plan/commit/advisor`, each mappable to a
  different model/vendor via `modelRoles` (we already run glm-5.2 default / glm-5.1
  smol).
- **`advisor` role:** "pair a second model that passively reviews each turn and
  injects notes." Config surface: `advisor.enabled`, `advisor.subagents`,
  `advisor.immuneTurns`, `advisor.syncBacklog`, and interrupt-on-concern.
- **Per-subagent models:** `task`-spawned subagents each run their own model →
  mixed-model fan-out.
- **Hooks:** `onToolCall`/`onToolResult` with `{ block, reason }`.
- **Extensions:** `createTool`, `registerCommand`, `systemPromptAppend`, subagents.

### Mapping: each council piece → the omp primitive it extends
| Council need | omp primitive to build on | What the addon adds |
| --- | --- | --- |
| Second model watches the porter | **`advisor` role** (reviews each turn, injects notes, can interrupt) | point it at a **different vendor** than the porter; wire concerns to the gate |
| Ban-safe / not-every-turn | **`advisor.syncBacklog`** (advisor runs async, may fall behind N turns) + **`immuneTurns`** | budget knob (`maxExternalAuditsPerHour`), batch at commit/symbol-complete |
| Review subagents' work too | **`advisor.subagents`** | apply cross-vendor + faithfulness rules to those reviews |
| Multiple role-typed advisors | **per-subagent models** + `task` | roster of `{provider, role, trigger, weight, order}`; omp's advisor is singular, addon makes it plural + ordered |
| Correctness gate | **`onToolResult` hook** (`block` on fail) | DPS-delta-vs-C++, coefficient-touch, compile-fail triggers |
| Method review | advisor reasoning pass (not output-gated) | sampled/approach-time invocation + method-reviewer role |
| Different model per role | **`modelRoles`** (already configured) | assign cross-vendor models per advisor role |
| The council tool + config | **extension** (`createTool`, `systemPromptAppend`) | `/council` tool, roster config file, JSONL audit log |

### What omp does NOT give (the addon's actual delta)
1. **Cross-vendor enforcement** — auditor must be a *different vendor* than porter
   (omp's advisor is model-agnostic but doesn't enforce diversity).
2. **A plural, ordered, role-typed roster** — omp has one advisor; the council is
   many with roles/order/weight.
3. **Domain triggers** — DPS delta vs cited C++, coefficient-touch regex,
   compile/smoke fail, method-review sampling.
4. **Faithfulness logic** — compare the port against the cited C++ `file:line`.
5. **Budget/ban-safety knobs** beyond `syncBacklog`.

So the build is: **configure omp's advisor/roles/subagents, then add (1)–(5) as a
thin extension + hook.** Orchestration, async review, interrupt, per-role models,
subagent review — all already there. This is a much smaller lift than the MVP
below implies; treat the MVP as "extend the advisor," not "build a review engine."

## MVP scope
1. **`council_audit` tool** (extension): input = changed file + cited C++
   `file:line` (+ optional diff). Fans out to N configured reviewer models
   (different vendors) as subagents, each returns a typed verdict
   {faithful: bool, issues: [...], cited_lines_match: bool}. Merge → single
   verdict (agree / disagree / split).
2. **Auto-invocation:** AGENTS.md rule (Tier 1) + `tool_result` hook on
   `simc_port/**` edits (Tier 3) that calls `council_audit` and blocks on a
   faithfulness fail.
3. **Config:** reviewer roster in `~/.omp/agent/council.json` (which providers,
   how many, agree-threshold).
4. **Output:** verdict rendered in omp + appended to `port_progress.log` /
   an audit line in `events`-style JSONL for the inspectability RV always wanted.

## Build order
1. Extension: `council_audit` custom tool calling 2 cross-vendor reviewers
   (GLM porter → DeepSeek + Nemotron auditors). Manual `/council` first.
2. AGENTS.md rule so GLM calls it after each port (Tier 1) — validate it triggers
   like the C++ check does.
3. `tool_result` hook for deterministic gating on `simc_port/**` (Tier 3).
4. Config file + JSONL audit log.
5. Package for auto-discovery: ship the `.ts` files for
   `~/.omp/agent/{extensions,hooks}/`; later publish to npm / omp marketplace.

## Distribution
Free. Drop-in via `~/.omp/agent/extensions/` + `~/.omp/agent/hooks/` (auto-
discovered), then optional npm package + omp marketplace entry. Reputation/utility
play, not revenue — and it makes our own port more faithful on day one.

## References (installed omp pkg)
- `examples/hooks/README.md` — `pi.on("tool_call"…)`, `{ block, reason }`,
  `~/.omp/agent/hooks/`.
- `examples/extensions/README.md` — custom tools, `systemPromptAppend`, `subagent/`.
- `src/prompts/skills/autoload.md`, `manage-skill.md` — skill autoloading.
- `docs/hooks.md` — full hook API.
