# Resolve Vector for OMP

Resolve Vector is a cross-model reasoning addon for Oh My Pi. It reviews,
compares, and synthesizes model outputs without opening or focusing external
application windows.

This repository is the clean implementation workspace for the OMP pivot. The
product and engineering specifications are in [`docs/`](./docs/).

## Initial target

The first vertical slice will provide:

- `/rv review` for explicit review;
- automatic review at the completion boundary;
- one local OpenAI-compatible provider and one remote API provider;
- concise visible status and a durable JSONL receipt;
- loop guards so Resolve Vector never reviews its own corrective turn.

See [`docs/RV_OMP_ADDON_IMPLEMENTATION_BRIEF_2026-07-22.md`](./docs/RV_OMP_ADDON_IMPLEMENTATION_BRIEF_2026-07-22.md)
for the complete implementation contract.

## Development

```bash
npm install
npm run check   # typecheck
npm test        # bun test (31 tests across policy, council, receipts, domain)
```

OMP discovers the extension from `src/index.ts` using the `omp.extensions`
entry in `package.json`, or ad hoc via `omp -e ./src/index.ts`.

## Configuration

RV reads `~/.omp/agent/resolve-vector.json` (created by you, not by RV):

```json
{
  "mode": "manual",
  "reviewers": [
    {
      "id": "local-qwen",
      "provider": "vllm-mlx",
      "model": "/Users/jgrayson/models/Qwen3-Coder-Next-MLX-8bit",
      "family": "qwen",
      "role": "critic",
      "local": true,
      "enabled": true,
      "order": 1
    }
  ]
}
```

`provider`/`model` resolve through OMP's own model registry — reviewers use the
same authenticated providers the session already trusts. Family diversity is
checked live against the catalog: a reviewer from the primary model's family
is skipped, never consulted.

Verdicts append to `~/.omp/agent/resolve-vector.receipts.jsonl` (secrets
redacted before write). `/rv status` reads mode, roster, budgets, and recent
verdicts from these receipts.

## Status

Milestone 1 (vertical slice) works and is smoke-tested end to end:
`/rv review` and the model-callable `council_audit` tool run a real
cross-family review (GLM primary → local Qwen reviewer) with a typed verdict
and durable receipt. `best`/`fusion`/`compare` return an explicit
not-yet-implemented error until Milestone 3; `agent_end` activation is
Milestone 2.
