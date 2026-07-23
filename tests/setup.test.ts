import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { DEFAULT_CONFIG, type ResolveVectorConfig } from "../src/policy.js";
import type { RVEngine } from "../src/runtime.js";
import { applySetup, buildCandidateList, isLocalBaseUrl, runSetupWizard, writeConfigAtomic } from "../src/setup.js";

// Model doubles: the wizard reads provider/id/baseUrl only.
function model(provider: string, id: string, baseUrl: string): Model {
  return { provider, id, baseUrl, name: id } as Model;
}

const FAMILIES: Record<string, string> = {
  "zai/glm-5.2": "glm",
  "local/qwen-coder": "qwen",
  "kimi-code/kimi-for-coding": "moonshot",
  "local/llama-3": "llama",
};

interface WizardHarness {
  ctx: ExtensionCommandContext;
  runtime: RVEngine;
  configPath: string;
  notifications: string[];
  reloads: number;
  answers: { selects: (string | undefined)[]; confirms: boolean[] };
}

function makeHarness(
  dir: string,
  options: {
    models: Model[];
    primary?: Model;
    selects?: (string | undefined)[];
    confirms?: boolean[];
    existingConfig?: string;
    config?: Partial<ResolveVectorConfig>;
  },
): WizardHarness {
  const notifications: string[] = [];
  const selects = [...(options.selects ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const config: ResolveVectorConfig = { ...DEFAULT_CONFIG, reviewers: [], ...(options.config ?? {}) };
  const state = { reloads: 0 };
  const runtime: RVEngine = {
    paths: {
      configPath: join(dir, "resolve-vector.json"),
      receiptsPath: join(dir, "r.jsonl"),
      ledgerPath: join(dir, "b.jsonl"),
    },
    config,
    configErrors: [],
    configCreated: options.existingConfig === undefined,
    setMode: () => {},
    runReview: () => Promise.reject(new Error("not under test")),
    runEnsemble: () => Promise.reject(new Error("not under test")),
    recentReceipts: () => Promise.resolve([]),
    reload: () => {
      state.reloads += 1;
      // Mirror the real reload(): fresh config exists on disk now.
      runtime.configCreated = false;
      return Promise.resolve();
    },
  };
  const ui = {
    select: (_title: string, items: (string | { label: string })[]) => {
      const next = selects.shift();
      if (next === undefined) return Promise.resolve(undefined);
      // The wizard expects an exact label back.
      const labels = items.map((i) => (typeof i === "string" ? i : i.label));
      assert.ok(labels.includes(next), `scripted answer "${next}" must be an option: ${labels.join(", ")}`);
      return Promise.resolve(next);
    },
    confirm: () => Promise.resolve(confirms.shift() ?? false),
    input: () => Promise.resolve(undefined),
    notify: (message: string) => notifications.push(message),
  };
  const ctx = {
    ui,
    model: options.primary,
    models: {
      list: () => options.models,
      current: () => options.primary,
      family: (m: Model) => FAMILIES[`${m.provider}/${m.id}`] ?? m.provider,
      resolve: () => undefined,
    },
    modelRegistry: { getApiKey: () => Promise.resolve(undefined) },
  } as unknown as ExtensionCommandContext;
  return { ctx, runtime, configPath: runtime.paths.configPath, notifications, get reloads() { return state.reloads; }, answers: { selects, confirms } };
}

const THREE_MODELS = [
  model("zai", "glm-5.2", "http://127.0.0.1:11436/v1"),
  model("local", "qwen-coder", "http://127.0.0.1:8001/v1"),
  model("kimi-code", "kimi-for-coding", "https://api.kimi.com/coding/v1"),
];

test("buildCandidateList annotates authenticated models and excludes the primary family", () => {
  const list = buildCandidateList(
    THREE_MODELS,
    (m) => FAMILIES[`${m.provider}/${m.id}`],
    { provider: "zai", id: "glm-5.2", family: "glm" },
  );
  assert.equal(list.length, 3);
  const primary = list.find((c) => c.id === "glm-5.2");
  assert.equal(primary?.eligible, false);
  assert.match(primary?.reason ?? "", /primary/);
  assert.equal(list.find((c) => c.id === "qwen-coder")?.eligible, true);
  assert.equal(list.find((c) => c.id === "kimi-for-coding")?.eligible, true);
  // Same family but different model id is also excluded.
  const glmSibling = buildCandidateList(
    [model("zai", "glm-5.1", "http://127.0.0.1:11436/v1")],
    () => "glm",
    { provider: "zai", id: "glm-5.2", family: "glm" },
  );
  assert.equal(glmSibling[0].eligible, false);
  assert.match(glmSibling[0].reason ?? "", /cross-family/);
});

test("isLocalBaseUrl detects loopback endpoints and nothing else", () => {
  assert.equal(isLocalBaseUrl("http://127.0.0.1:8001/v1"), true);
  assert.equal(isLocalBaseUrl("http://localhost:11434/v1"), true);
  assert.equal(isLocalBaseUrl("http://[::1]:8000/v1"), true);
  assert.equal(isLocalBaseUrl("https://api.kimi.com/coding/v1"), false);
  assert.equal(isLocalBaseUrl("https://192.168.1.10:8001/v1"), false); // LAN is still external
  assert.equal(isLocalBaseUrl(undefined), false);
});

test("wizard: local seat defaults local-only; external seat defaults external-redacted without explicit opt-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const h = makeHarness(dir, {
    models: THREE_MODELS,
    primary: THREE_MODELS[0],
    selects: ["local/qwen-coder", "kimi-code/kimi-for-coding", "manual (recommended)"],
    confirms: [false, true], // no full-content opt-in; confirm write
    existingConfig: undefined,
  });
  await runSetupWizard(h.runtime, h.ctx, "17.0.7");
  const written = JSON.parse(await readFile(h.runtime.paths.configPath, "utf8")) as ResolveVectorConfig;
  const qwen = written.reviewers.find((r) => r.model === "qwen-coder");
  const kimi = written.reviewers.find((r) => r.model === "kimi-for-coding");
  assert.equal(qwen?.scope, "local-only");
  assert.equal(qwen?.local, true);
  assert.equal(kimi?.scope, "external-redacted");
  assert.equal(kimi?.local, false);
  assert.equal(written.mode, "manual");
});

test("wizard: external-allowed requires an explicit confirm", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const h = makeHarness(dir, {
    models: THREE_MODELS,
    primary: THREE_MODELS[0],
    selects: ["kimi-code/kimi-for-coding", "Done selecting", "manual (recommended)"],
    confirms: [true, true], // full-content opt-in; confirm write
  });
  await runSetupWizard(h.runtime, h.ctx, "17.0.7");
  const written = JSON.parse(await readFile(h.runtime.paths.configPath, "utf8")) as ResolveVectorConfig;
  assert.equal(written.reviewers[0].scope, "external-allowed");
});

test("wizard: cancellation at every stage leaves config unchanged", async () => {
  const original = '{"mode":"always","customKey":"keep-me","reviewers":[]}';
  const stages: { stage: string; selects: (string | undefined)[]; confirms: boolean[] }[] = [
    { stage: "reviewer select", selects: [undefined], confirms: [] },
    { stage: "mode select", selects: ["local/qwen-coder", "Done selecting", undefined], confirms: [false] },
    { stage: "write confirm", selects: ["local/qwen-coder", "Done selecting", "manual (recommended)"], confirms: [false, false] },
  ];
  for (const stage of stages) {
    const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
    const configPath = join(dir, "resolve-vector.json");
    await writeFile(configPath, original, "utf8");
    const h = makeHarness(dir, {
      models: THREE_MODELS,
      primary: THREE_MODELS[0],
      selects: stage.selects,
      confirms: stage.confirms,
      existingConfig: original,
    });
    await runSetupWizard(h.runtime, h.ctx, "17.0.7");
    assert.equal(await readFile(configPath, "utf8"), original, `config must be unchanged when cancelled at: ${stage.stage}`);
  }
});

test("applySetup preserves unrelated existing settings", () => {
  const merged = applySetup(
    { mode: "always", maxExternalAuditsPerHour: 42, _comment: "user note", customFutureKey: { nested: true } },
    { mode: "auto", reviewers: [] },
  ) as Record<string, unknown>;
  assert.equal(merged.mode, "auto");
  assert.equal(merged.maxExternalAuditsPerHour, 42);
  assert.equal(merged._comment, "user note");
  assert.deepEqual(merged.customFutureKey, { nested: true });
  assert.deepEqual(merged.reviewers, []);
});

test("writeConfigAtomic writes valid JSON and backs up the previous config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const path = join(dir, "resolve-vector.json");
  await writeFile(path, '{"mode":"always"}', "utf8");
  const backup = await writeConfigAtomic(path, { mode: "manual", reviewers: [] });
  assert.ok(backup, "backup path expected");
  assert.equal(await readFile(backup, "utf8"), '{"mode":"always"}');
  const written = JSON.parse(await readFile(path, "utf8")) as { mode: string };
  assert.equal(written.mode, "manual");
  // No tmp litter.
  const tmp = join(dir, "resolve-vector.json.tmp-1");
  assert.rejects(readFile(tmp, "utf8"));
});

test("wizard: full path writes config, reloads runtime, and runs doctor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const h = makeHarness(dir, {
    models: THREE_MODELS,
    primary: THREE_MODELS[0],
    selects: ["local/qwen-coder", "Done selecting", "manual (recommended)"],
    confirms: [true],
  });
  await runSetupWizard(h.runtime, h.ctx, "17.0.7");
  assert.equal(h.reloads, 1, "runtime must reload after write — no restart needed");
  const text = h.notifications.join("\n");
  assert.match(text, /config written/);
  assert.match(text, /RV doctor — \d+\/\d+ checks pass/);
  assert.match(text, /setup complete/);
});

test("wizard: secrets never appear in any rendered output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const sneaky = model("evil", "sk-proj-abc123def456ghi789", "https://api.evil.example/v1");
  const h = makeHarness(dir, {
    models: [THREE_MODELS[0], sneaky],
    primary: THREE_MODELS[0],
    selects: ["evil/sk-proj-abc123def456ghi789", "manual (recommended)"],
    confirms: [false, true],
  });
  // The wizard must never consult the credential store for display.
  let credentialsTouched = false;
  (h.ctx as unknown as { modelRegistry: { getApiKey: () => Promise<string | undefined> } }).modelRegistry = {
    getApiKey: () => {
      credentialsTouched = true;
      return Promise.resolve("sk-real-secret");
    },
  };
  await runSetupWizard(h.runtime, h.ctx, "17.0.7");
  assert.equal(credentialsTouched, false, "wizard must not read credentials");
  assert.ok(!h.notifications.join("\n").includes("sk-real-secret"));
});

test("wizard: no eligible models aborts with guidance and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-setup-"));
  const onlyPrimary = [THREE_MODELS[0]];
  const h = makeHarness(dir, { models: onlyPrimary, primary: THREE_MODELS[0], selects: [], confirms: [] });
  await runSetupWizard(h.runtime, h.ctx, "17.0.7");
  assert.match(h.notifications.join("\n"), /no eligible reviewers/);
  await assert.rejects(readFile(h.runtime.paths.configPath, "utf8"));
});
