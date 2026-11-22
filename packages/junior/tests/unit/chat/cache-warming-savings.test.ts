import { describe, expect, it } from "vitest";
import {
  idlePeriodOutcome,
  idlePeriodSavings,
} from "@/chat/cache-warming/savings";

const MINUTE = 60_000;
// Anthropic prices per million tokens: a write costs 12.5 reads.
const period = {
  cacheTtlMs: 5 * MINUTE,
  prefixTokens: 100_000,
  cacheRead: 100_000,
  cacheWrite: 0,
  cacheReadPrice: 0.5,
  cacheWritePrice: 6.25,
};

const MISS = { cacheRead: 0, cacheWrite: 100_000 };

describe("cache warming savings", () => {
  it.each([
    // An ideal warmer sends one warmup per 4m15s after the 5m10s grace. A
    // warmup costs 1.1 reads.
    ["a hit that needs one warmup", 9 * MINUTE, {}, 0.52, 0.575],
    ["a hit that needs two warmups", 10 * MINUTE, {}, 0.465, 0.575],
    ["a miss", 9 * MINUTE, { cacheRead: 0, cacheWrite: 100_000 }, 0.52, 0],
  ])("counts %s", (_name, gapMs, usage, oracleUsd, savedUsd) => {
    const savings = idlePeriodSavings({ ...period, ...usage, gapMs });
    expect(savings).toEqual({
      hit: savedUsd > 0,
      oracleUsd: expect.closeTo(oracleUsd),
      savedUsd: expect.closeTo(savedUsd),
    });
  });

  it.each([
    ["a return before the TTL and its grace end", 5 * MINUTE + 10_000, {}],
    ["a context that shrank", 9 * MINUTE, { cacheRead: 40_000 }],
    ["a gap that warming never pays for", 60 * MINUTE, {}],
    ["a prefix too small to warm", 9 * MINUTE, { prefixTokens: 10_000 }],
    ["a model whose write costs no more", 9 * MINUTE, { cacheWritePrice: 0.5 }],
  ])("skips %s", (_name, gapMs, input) => {
    expect(idlePeriodSavings({ ...period, ...input, gapMs })).toBeUndefined();
  });

  it.each([
    ["a hit", 10 * MINUTE, {}, 2, "saved"],
    ["a miss with no warmups", 10 * MINUTE, MISS, 0, "not_warmed"],
    // The return needed two warmups, so its cache expired after the first.
    ["a miss after too few warmups", 10 * MINUTE, MISS, 1, "stopped_early"],
    ["a miss after enough warmups", 10 * MINUTE, MISS, 2, "cache_lost"],
  ])("names the outcome of %s", (_name, gapMs, usage, warmups, outcome) => {
    const savings = idlePeriodSavings({ ...period, ...usage, gapMs });
    if (!savings) throw new Error("expected the period to count");
    expect(idlePeriodOutcome({ ...period, gapMs }, savings, warmups)).toBe(
      outcome,
    );
  });
});
