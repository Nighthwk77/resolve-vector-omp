import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerRvCommand } from "../src/commands.js";
import { DEFAULT_CONFIG, type ActivationMode, type ResolveVectorConfig } from "../src/policy.js";
import type { RVEngine } from "../src/runtime.js";

type Notify = { message: string; type?: string };

/** Command-ctx double: only ui.notify is exercised by these paths. */
function fakeCtx(notifications: Notify[]): ExtensionCommandContext {
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => {
        notifications.push({ message, type });
      },
    },
  };
  // Test double: only the surface the command touches exists.
  return ctx as unknown as ExtensionCommandContext;
}

/** Engine fake: config + setMode are the only members /rv on|off touch. */
function fakeEngine(): RVEngine {
  const engine = {
    config: { ...DEFAULT_CONFIG, reviewers: [] } as ResolveVectorConfig,
    paths: { configPath: "/tmp/rv-fake/config.json", receiptsPath: "/tmp/rv-fake/r.jsonl", ledgerPath: "/tmp/rv-fake/b.jsonl" },
    configErrors: [],
    configCreated: true,
    setMode(mode: ActivationMode) {
      engine.config = { ...engine.config, mode };
    },
    runReview: () => Promise.reject(new Error("not under test")),
    runEnsemble: () => Promise.reject(new Error("not under test")),
    recentReceipts: () => Promise.resolve([]),
    reload: () => Promise.resolve(),
  };
  return engine;
}

function captureCommand(engine: RVEngine): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof handler }) => {
      handler = options.handler;
    },
  };
  registerRvCommand(pi as unknown as Parameters<typeof registerRvCommand>[0], engine);
  assert.ok(handler, "rv command must register");
  const registered = handler;
  return (args, ctx) => registered(args, ctx);
}

test("/rv on enables automatic review honestly (session-scoped, not persisted)", async () => {
  const engine = fakeEngine();
  const handler = captureCommand(engine);
  const notifications: Notify[] = [];
  await handler("on always", fakeCtx(notifications));
  assert.equal(engine.config.mode, "always");
  const text = notifications.map((n) => n.message).join("\n");
  assert.match(text, /automatic review at completion enabled/i);
  assert.match(text, /this session/i); // honest about not persisting
});

test("/rv off sets mode off", async () => {
  const engine = fakeEngine();
  const handler = captureCommand(engine);
  await handler("off", fakeCtx([]));
  assert.equal(engine.config.mode, "off");
});

test("/rv on rejects unknown modes with usage", async () => {
  const engine = fakeEngine();
  const handler = captureCommand(engine);
  const notifications: Notify[] = [];
  await handler("on turbo", fakeCtx(notifications));
  assert.equal(engine.config.mode, DEFAULT_CONFIG.mode); // unchanged
  assert.match(notifications[0].message, /usage/i);
});
