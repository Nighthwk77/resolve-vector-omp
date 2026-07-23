import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreakerRegistry } from "../src/circuit-breaker.js";

const COOLDOWN = 300_000;

test("closed by default; check() allows dispatch", () => {
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => 0 });
  assert.equal(registry.check("qwen"), undefined);
  assert.deepEqual(registry.snapshot("qwen"), { state: "closed", remainingMs: 0 });
});

test("a generation failure opens the circuit and reports remaining cooldown", () => {
  let now = 1_000_000;
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => now });
  registry.recordFailure("qwen", "timeout_first_token");
  const block = registry.check("qwen");
  assert.equal(block?.state, "open");
  assert.equal(block?.reason, "timeout_first_token");
  assert.equal(block?.remainingMs, COOLDOWN);
  now += 60_000;
  assert.equal(registry.check("qwen")?.remainingMs, COOLDOWN - 60_000);
});

test("expired cooldown grants exactly one half-open trial; success closes", () => {
  let now = 1_000_000;
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => now });
  registry.recordFailure("qwen", "transport");
  now += COOLDOWN + 1;
  assert.equal(registry.check("qwen"), undefined, "trial allowed");
  assert.equal(registry.snapshot("qwen").state, "half_open");
  assert.equal(registry.check("qwen"), undefined, "the trial stays available until the outcome lands");
  registry.recordSuccess("qwen");
  assert.deepEqual(registry.snapshot("qwen"), { state: "closed", remainingMs: 0 });
  assert.equal(registry.check("qwen"), undefined);
});

test("half-open failure re-opens with a fresh cooldown", () => {
  let now = 1_000_000;
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => now });
  registry.recordFailure("qwen", "timeout_first_token");
  now += COOLDOWN + 1;
  registry.check("qwen"); // half-open trial
  registry.recordFailure("qwen", "timeout_first_token");
  const block = registry.check("qwen");
  assert.equal(block?.state, "open");
  assert.equal(block?.remainingMs, COOLDOWN, "cooldown restarts from the re-open");
});

test("beginProbe forces a half-open trial before cooldown expiry (doctor / reviewer retry)", () => {
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => 0 });
  registry.recordFailure("qwen", "malformed_stream");
  assert.equal(registry.check("qwen")?.state, "open");
  const probe = registry.beginProbe("qwen");
  assert.equal(probe.state, "half_open");
  assert.equal(registry.check("qwen"), undefined, "probe trial may run");
});

test("beginProbe on a closed circuit is a no-op", () => {
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => 0 });
  assert.deepEqual(registry.beginProbe("qwen"), { state: "closed", remainingMs: 0 });
});

test("success on a healthy seat clears any prior failure state", () => {
  const registry = new CircuitBreakerRegistry({ cooldownMs: COOLDOWN, now: () => 0 });
  registry.recordFailure("qwen", "timeout_total");
  registry.beginProbe("qwen");
  registry.recordSuccess("qwen");
  assert.equal(registry.snapshot("qwen").state, "closed");
  assert.equal(registry.all().size, 0, "closed seats drop out of the registry view");
});
