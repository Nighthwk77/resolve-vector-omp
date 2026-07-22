import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExternalBudget, DEFAULT_CONFIG, ExternalBudgetTracker, FileBudgetLedger, loadConfig, parseConfig } from "../src/policy.js";

test("parseConfig with empty input yields defaults", () => {
  const { config, errors } = parseConfig(undefined);
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { ...DEFAULT_CONFIG, reviewers: [] });
});

test("parseConfig rejects invalid mode but keeps the rest", () => {
  const { config, errors } = parseConfig({ mode: "aggressive", candidateCount: 4 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /mode/);
  assert.equal(config.mode, DEFAULT_CONFIG.mode);
  assert.equal(config.candidateCount, 4);
});

test("parseConfig validates reviewer fields and reports positions", () => {
  const { config, errors } = parseConfig({
    reviewers: [
      { id: "a", provider: "local", model: "qwen", family: "qwen", role: "critic", local: true },
      { provider: "x" },
      { id: "a", provider: "y", model: "m", family: "f", role: "critic", local: false },
    ],
  });
  assert.equal(config.reviewers.length, 2);
  assert.ok(errors.some((e) => e.includes("reviewers[1]")));
  assert.ok(errors.some((e) => e.includes("duplicate id")));
});

test("parseConfig sorts reviewers by order and defaults enabled", () => {
  const { config, errors } = parseConfig({
    reviewers: [
      { id: "second", provider: "p", model: "m", family: "f", role: "critic", local: true, order: 2 },
      { id: "first", provider: "p", model: "m", family: "f", role: "verifier", local: true, order: 1 },
    ],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config.reviewers.map((r) => r.id), ["first", "second"]);
  assert.equal(config.reviewers[0].enabled, true);
});

test("parseConfig rejects out-of-range numbers and non-booleans", () => {
  const { errors } = parseConfig({ sampleRate: 2, runInBackground: "yes", maxConcurrentReviewers: 99 });
  assert.equal(errors.length, 3);
});

test("loadConfig returns defaults with created=true for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-policy-"));
  const result = await loadConfig(join(dir, "nope.json"));
  assert.equal(result.created, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.mode, DEFAULT_CONFIG.mode);
});

test("loadConfig surfaces invalid JSON as an actionable error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-policy-"));
  const path = join(dir, "resolve-vector.json");
  await writeFile(path, "{ not json", "utf8");
  const result = await loadConfig(path);
  assert.equal(result.created, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /invalid JSON/);
});

test("checkExternalBudget enforces hourly then daily caps", () => {
  const now = 10_000_000_000;
  const config = { ...DEFAULT_CONFIG, maxExternalAuditsPerHour: 2, maxExternalAuditsPerDay: 3, reviewers: [] };
  assert.equal(checkExternalBudget(config, [], now).allowed, true);
  const twoThisHour = [now - 1000, now - 2000];
  const hourDecision = checkExternalBudget(config, twoThisHour, now);
  assert.equal(hourDecision.allowed, false);
  assert.match(hourDecision.reason ?? "", /hour/);
  // Hourly cap clear but daily cap hit: two calls 20h ago + one this hour.
  const dailyDecision = checkExternalBudget(config, [now - 72_000_000, now - 72_100_000, now - 1000], now);
  assert.equal(dailyDecision.allowed, false);
  assert.match(dailyDecision.reason ?? "", /day/);
});

test("ExternalBudgetTracker reserves atomically — concurrent checks cannot both pass", () => {
  const now = 10_000_000_000;
  const config = { ...DEFAULT_CONFIG, maxExternalAuditsPerHour: 1, reviewers: [] };
  const tracker = new ExternalBudgetTracker(config, []);
  // Two synchronous reservations back-to-back: the second must see the first.
  assert.equal(tracker.tryReserve(now).allowed, true);
  const second = tracker.tryReserve(now);
  assert.equal(second.allowed, false);
  assert.match(second.reason ?? "", /hour/);
});

test("ExternalBudgetTracker reports reservations to its observer", () => {
  const observed: number[] = [];
  const tracker = new ExternalBudgetTracker({ ...DEFAULT_CONFIG, reviewers: [] }, [], (t) => observed.push(t));
  tracker.tryReserve(1000);
  tracker.tryReserve(2000);
  assert.deepEqual(observed, [1000, 2000]);
});

test("FileBudgetLedger: two instances (two processes) reserve atomically under the lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-ledger-"));
  const ledgerPath = join(dir, "budget.jsonl");
  const config = { ...DEFAULT_CONFIG, maxExternalAuditsPerHour: 2, reviewers: [] };
  const ledgerA = new FileBudgetLedger(config, ledgerPath);
  const ledgerB = new FileBudgetLedger(config, ledgerPath);
  const now = 10_000_000_000;
  const decisions = await Promise.all([
    ledgerA.tryReserve(now),
    ledgerB.tryReserve(now),
    ledgerA.tryReserve(now),
    ledgerB.tryReserve(now),
  ]);
  assert.equal(decisions.filter((d) => d.allowed).length, 2);
});

test("FileBudgetLedger: stale lock from a dead process is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-ledger-"));
  const ledgerPath = join(dir, "budget.jsonl");
  const lockPath = `${ledgerPath}.lock`;
  await writeFile(lockPath, "999999", "utf8");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const ledger = new FileBudgetLedger({ ...DEFAULT_CONFIG, reviewers: [] }, ledgerPath);
  const decision = await ledger.tryReserve(Date.now());
  assert.equal(decision.allowed, true);
});

// Real-timer exception: this polls real filesystem state (lockfile ownership
// changes driven by async critical sections); there is no event or promise to
// await instead, and fake timers cannot backdate a lockfile's mtime.
async function waitForFile(path: string, content?: { notEquals?: string }): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (content?.notEquals === undefined || text !== content.notEquals) return text;
    } catch {
      // not there yet
    }
    if (Date.now() > deadline) throw new Error(`waitForFile timeout: ${path}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

test("FileBudgetLedger: a stale-stolen owner never removes the replacement owner's lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-ledger-"));
  const ledgerPath = join(dir, "budget.jsonl");
  const lockPath = `${ledgerPath}.lock`;
  const config = { ...DEFAULT_CONFIG, reviewers: [] };
  const now = Date.now();

  // Gates hold each owner's critical section open (the bootstrap seed read is
  // inside the lock), letting us script the exact steal/interleave sequence.
  const gateA = Promise.withResolvers<void>();
  const gateB = Promise.withResolvers<void>();
  const ledgerA = new FileBudgetLedger(config, ledgerPath, async () => {
    await gateA.promise;
    return [];
  });
  const ledgerB = new FileBudgetLedger(config, ledgerPath, async () => {
    await gateB.promise;
    return [];
  });

  // 1. A acquires the lock and parks inside its critical section.
  const reserveA = ledgerA.tryReserve(now);
  const tokenA = await waitForFile(lockPath);

  // 2. A's lock ages past the stale threshold.
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);

  // 3. B steals the stale lock and becomes the current owner (also parked).
  const reserveB = ledgerB.tryReserve(now);
  const tokenB = await waitForFile(lockPath, { notEquals: tokenA });

  // 4. A finishes and releases — it must NOT unlink B's replacement lock.
  gateA.resolve();
  assert.equal((await reserveA).allowed, true);
  const stillLocked = await readFile(lockPath, "utf8").catch(() => "");
  assert.equal(stillLocked, tokenB, "A's release must preserve B's lock");

  // 5. A third contender cannot enter while B holds the lock.
  const ledgerC = new FileBudgetLedger(config, ledgerPath);
  let cDone = false;
  const reserveC = ledgerC.tryReserve(now).then((d) => {
    cDone = true;
    return d;
  });
  // Real-timer exception: negative assertion that C stays blocked on the real
  // lockfile retry loop; a fake clock cannot stand in for actual FS contention.
  const { promise: breather, resolve: breathe } = Promise.withResolvers<void>();
  setTimeout(breathe, 200);
  await breather;
  assert.equal(cDone, false, "C must block until B releases");

  // 6. B releases; normal acquisition resumes for C.
  gateB.resolve();
  assert.equal((await reserveB).allowed, true);
  assert.equal((await reserveC).allowed, true);
  assert.equal(cDone, true);
});
