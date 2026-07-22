# Resolve Vector OMP implementation guidance

Build Resolve Vector as a general cross-model reasoning, review, selection, and
synthesis addon for Oh My Pi. It is not limited to source ports.

## Read first

Before planning or implementing substantial work, read:

1. `docs/RV_OMP_ADDON_IMPLEMENTATION_BRIEF_2026-07-22.md` — the implementation
   contract and release gates.
2. `docs/RV_OMP_ADDON_PIVOT_2026-07-22.md` — product rationale and positioning.
3. `docs/FABLE72126.md` — external repositories and techniques worth adapting.

## Reference implementations

- Treat the installed OMP source and examples at
  `/Users/jgrayson/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`
  as authoritative for the OMP 17.0.7 extension API, lifecycle events,
  commands, tools, UI, providers, and package discovery.
- Inspect the legacy Resolve Vector repository at
  `/Users/jgrayson/Documents/ResolveVector` for reusable provider, orchestration,
  reporting, policy, prompt, and evaluation code. It is reference material, not
  the implementation target.
- Use the repositories catalogued in `docs/FABLE72126.md` to inform design and
  implementation. Verify current upstream code and licenses before adapting it.

## Working boundaries

- Make implementation changes only in this repository unless the user asks for
  a change elsewhere.
- Do not copy large subsystems blindly. Extract the smallest proven mechanism
  that improves speed, accuracy, task completion, observability, or reliability.
- Prefer OMP-native sessions, context, tools, providers, UI, and extension hooks
  over rebuilding agent infrastructure.
- Keep provider calls headless. Do not open or focus external application
  windows as part of normal execution.
- Preserve visible progress and readable reasoning summaries so users can steer
  long runs.
- Every material feature needs a focused test and evidence against the release
  gates in the implementation brief.

## Immediate milestone

Complete the smallest end-to-end vertical slice first: `/rv review`, one local
OpenAI-compatible reviewer, one remote API reviewer, a typed verdict, concise
visible status, and a durable JSONL receipt. Then add automatic completion
review and corrective turns with strict recursion guards.
