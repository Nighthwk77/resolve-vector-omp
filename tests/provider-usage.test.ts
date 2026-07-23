import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { compactGlmUsage, detailedGlmUsage, fetchGlmUsage } from "../src/provider-usage.js";

const liveUsage = {
  ok: true,
  five_hour: {
    type: "TOKENS_LIMIT",
    window: "5 hours",
    remaining_percent: 76,
  },
  windows: [
    {
      type: "TIME_LIMIT",
      window: "1 month",
      remaining: 946,
      limit: 1000,
      remaining_percent: 95,
      resets_at: "2026-08-13T00:13:55Z",
    },
  ],
};

describe("provider usage", () => {
  test("renders persistent five-hour quota compactly", () => {
    assert.equal(compactGlmUsage(liveUsage), "GLM 5h: 76% left");
  });

  test("renders complete details on demand", () => {
    const text = detailedGlmUsage(liveUsage);
    assert.match(text, /GLM 5h: 76% left/);
    assert.match(text, /1 month: 946\/1000 left/);
    assert.match(text, /1 month resets:/);
  });

  test("fails closed when the local usage endpoint is unavailable", async () => {
    const fetcher = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await fetchGlmUsage(fetcher);
    assert.equal(result.ok, false);
    assert.equal(compactGlmUsage(result), "GLM usage unavailable");
  });
});
