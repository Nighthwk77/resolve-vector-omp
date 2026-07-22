import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, extractJsonObject, parseReviewResponse } from "../src/domain/generic.js";

test("parseReviewResponse accepts clean JSON", () => {
  const parsed = parseReviewResponse(
    JSON.stringify({
      status: "concern",
      summary: "one issue",
      findings: [
        {
          severity: "high",
          category: "correctness",
          claim: "X",
          concern: "Y",
          evidence: [{ kind: "file", ref: "a.ts:1" }],
        },
      ],
    }),
  );
  assert.equal(parsed.status, "concern");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].evidence[0].ref, "a.ts:1");
});

test("parseReviewResponse tolerates prose and code fences around the JSON", () => {
  const text = `Here is my review:\n\`\`\`json\n{"status": "pass", "summary": "fine", "findings": []}\n\`\`\`\nHope that helps.`;
  const parsed = parseReviewResponse(text);
  assert.equal(parsed.status, "pass");
});

test("parseReviewResponse throws on missing JSON, invalid status, and malformed JSON", () => {
  assert.throws(() => parseReviewResponse("no object here"), /no JSON object/);
  assert.throws(() => parseReviewResponse('{"status": "great-job"}'), /invalid status/);
  assert.throws(() => parseReviewResponse("{not json}"), /malformed/);
});

test("parseReviewResponse normalizes junk finding fields to safe defaults", () => {
  const parsed = parseReviewResponse(
    JSON.stringify({
      status: "concern",
      summary: "s",
      findings: [{ severity: "catastrophic", category: "vibes", claim: "c", concern: "k", evidence: "none" }],
    }),
  );
  assert.equal(parsed.findings[0].severity, "medium");
  assert.equal(parsed.findings[0].category, "other");
  assert.deepEqual(parsed.findings[0].evidence, []);
});

test("parseReviewResponse drops findings without claim/concern", () => {
  const parsed = parseReviewResponse(
    JSON.stringify({ status: "concern", summary: "s", findings: [{ claim: "only claim" }, "junk", null] }),
  );
  assert.equal(parsed.findings.length, 0);
});

test("extractJsonObject handles nested braces and strings containing braces", () => {
  const json = extractJsonObject('pre {"a": "{not a close}", "b": {"c": 1}} post');
  assert.equal(json, '{"a": "{not a close}", "b": {"c": 1}}');
  assert.equal(extractJsonObject("nothing"), undefined);
  assert.equal(extractJsonObject("{unbalanced"), undefined);
});

test("buildReviewPrompt includes goal, proposal, constraints, and evidence", () => {
  const prompt = buildReviewPrompt({
    goal: "do X",
    proposal: "did X",
    constraints: ["must compile"],
    evidence: [{ kind: "file", ref: "x.cpp:9", detail: "coefficient" }],
  });
  assert.match(prompt, /do X/);
  assert.match(prompt, /did X/);
  assert.match(prompt, /must compile/);
  assert.match(prompt, /\[file\] x\.cpp:9 — coefficient/);
});
