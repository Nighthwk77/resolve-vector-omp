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

Restart OMP and run:

```text
/rv doctor
```

Seeing “no reviewers configured” at this point is expected.

## 3. Choose a reviewer

### Kimi reviewer

Use this when your primary model is not Kimi/Moonshot and Kimi already works in
OMP:

```bash
cp examples/kimi-external-redacted.json ~/.omp/agent/resolve-vector.json
```

This sends redacted task content to Kimi. Redaction removes common secret
shapes, but context and intent can still be sensitive.

### Local OpenAI-compatible reviewer

Use this for vllm-mlx, vLLM, Ollama, or LM Studio:

1. Confirm the server is running.
2. Query its models:

   ```bash
   curl http://127.0.0.1:8001/v1/models
   ```

3. Add the provider to `~/.omp/agent/models.yml` using the `_models_yml`
   template in `examples/local-openai-compatible.json`.
4. Copy the example to `~/.omp/agent/resolve-vector.json`.
5. Replace every `<model-id-from-/v1/models>` placeholder with the returned ID.

Local seats use `scope: "local-only"` and send nothing off the machine.

### Any provider already in OMP

Copy `examples/omp-provider.json`, then replace the provider, model, and family
placeholders with values from OMP’s `/model` picker:

```bash
cp examples/omp-provider.json ~/.omp/agent/resolve-vector.json
```

For cloud providers, keep `scope: "external-redacted"` until you have made an
explicit decision to allow full content.

## 4. Validate before reviewing

Restart OMP and run:

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
