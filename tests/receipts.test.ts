import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendReceipt,
  externalCallUnits,
  readReceipts,
  redactReceipt,
  redactSecrets,
  type ReviewReceipt,
} from "../src/receipts.js";

test("redactSecrets strips API keys, bearer tokens, and JWTs", () => {
  assert.equal(redactSecrets("key is sk-proj-abc123def456ghi789"), "key is [REDACTED]");
  assert.equal(redactSecrets("Authorization: Bearer eyJhbGciOiJ9.abc123.sig-part-here-ok"), "Authorization: [REDACTED]");
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  assert.equal(redactSecrets(`token: ${jwt}`), "token: [REDACTED]");
  assert.equal(redactSecrets("nothing secret here"), "nothing secret here");
});

test("redactReceipt walks nested structures", () => {
  const redacted = redactReceipt({
    outer: { key: "sk-ant-abcdefghijklmnop", list: ["Bearer abcdefgh12345678", 42, null] },
  });
  assert.equal(redacted.outer.key, "[REDACTED]");
  assert.equal(redacted.outer.list[0], "[REDACTED]");
  assert.equal(redacted.outer.list[1], 42);
});

function makeReceipt(
  id: string,
  reviewers: { local: boolean; status: "ok" | "error" | "timeout" | "skipped_budget"; calls?: number }[],
  createdAt: string,
): ReviewReceipt {
  return {
    receiptId: id,
    activationReason: "manual_command",
    revisionRound: 0,
    verdict: {
      id,
      mode: "review",
      status: "pass",
      summary: "s",
      findings: [],
      reviewers: reviewers.map((r, i) => ({
        reviewerId: `r${i}`,
        provider: "p",
        model: "m",
        family: "f",
        local: r.local,
        status: r.status,
        calls: r.calls,
        findings: [],
        latencyMs: 1,
      })),
      deterministicChecks: [],
      usage: { input: 0, output: 0, totalLatencyMs: 1 },
      createdAt,
    },
  };
}

test("appendReceipt + readReceipts round-trips and redacts on write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-receipts-"));
  const path = join(dir, "sub", "receipts.jsonl"); // missing parent dir: created lazily
  const receipt = makeReceipt("rv-1", [{ local: true, status: "ok" }], "2026-07-22T00:00:00.000Z");
  receipt.verdict.summary = "checked with key sk-live-abcdefghijklmnop";
  await appendReceipt(path, receipt);
  await appendReceipt(path, makeReceipt("rv-2", [], "2026-07-22T01:00:00.000Z"));

  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes("sk-live"), "secret must not hit disk");
  const receipts = await readReceipts(path);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].receiptId, "rv-1");
  assert.equal(receipts[1].receiptId, "rv-2");
});

test("readReceipts skips corrupt lines instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-receipts-"));
  const path = join(dir, "receipts.jsonl");
  const good = makeReceipt("rv-good", [], "2026-07-22T00:00:00.000Z");
  await writeFile(path, `${JSON.stringify(good)}\n{corrupt\n\n`, "utf8");
  const receipts = await readReceipts(path);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receiptId, "rv-good");
});

test("readReceipts on a missing file yields an empty log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-receipts-"));
  assert.deepEqual(await readReceipts(join(dir, "none.jsonl")), []);
});

test("externalCallUnits counts attempts, failures, and repair calls — not just successes", () => {
  const at = "2026-07-22T00:00:00.000Z";
  const receipts = [
    makeReceipt("a", [{ local: true, status: "ok" }], at), // local: free
    makeReceipt("b", [{ local: false, status: "ok" }], at), // 1
    makeReceipt("c", [{ local: false, status: "error" }], at), // 1 (failed attempt still costs)
    makeReceipt("d", [{ local: false, status: "timeout" }], at), // 1
    makeReceipt("e", [{ local: false, status: "ok", calls: 2 }], at), // 2 (repair retry)
    makeReceipt("f", [{ local: false, status: "skipped_budget" }], at), // 0 (never dispatched)
  ];
  const units = externalCallUnits(receipts);
  assert.equal(units.length, 5); // b 1 + c 1 + d 1 + e 2; local and skipped cost nothing
  assert.ok(units.every((t) => t === Date.parse(at)));
});
