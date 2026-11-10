import { describe, expect, it } from "vitest";
import {
  decideWarmup as decideWarmupAt,
  NO_REPLY_GAP_MS,
  parentGapSegment,
  type WarmupDecisionInput,
  warmupFailureCountsAsMiss,
} from "@/chat/cache-warming/model";
import { createProviderError } from "@/chat/services/provider-error";

const MINUTE = 60_000;
// Anthropic Opus prices in $/MTok and its 5-minute cache.
const prices = {
  cacheReadPrice: 0.2,
  cacheWritePrice: 5,
  cacheTtlMs: 5 * MINUTE,
};

function gaps(count: number, gapMs: number): number[] {
  return Array.from({ length: count }, () => gapMs);
}

// Most cases decide one minute before the current cache expires.
const decideWarmup = (
  input: Omit<WarmupDecisionInput, "cacheExpiryIdleMs"> &
    Partial<Pick<WarmupDecisionInput, "cacheExpiryIdleMs">>,
) => decideWarmupAt({ cacheExpiryIdleMs: input.idleMs + MINUTE, ...input });

describe("decideWarmup", () => {
  it("warms when people usually reply within the next cache TTL", () => {
    const decision = decideWarmup({
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: [...gaps(80, 7 * MINUTE), ...gaps(20, 3 * 60 * MINUTE)],
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    });

    expect(decision).toMatchObject({ warm: true, reason: "warm" });
    expect(decision.returnProbability).toBeGreaterThan(decision.threshold);
  });

  it("stops when the conversation's own replies come much later", () => {
    const decision = decideWarmup({
      ...prices,
      // The global gaps say "soon", but this conversation has enough gaps of
      // its own to replace them.
      conversationGapsMs: gaps(100, 3 * 60 * MINUTE),
      globalGapsMs: gaps(100, 7 * MINUTE),
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    });

    expect(decision).toMatchObject({ warm: false, reason: "unlikely_return" });
  });

  it("gives a conversation's own gaps their share next to a large global list", () => {
    const returnProbability = (ownGaps: number) =>
      decideWarmup({
        ...prices,
        conversationGapsMs: gaps(ownGaps, 3 * 60 * MINUTE),
        globalGapsMs: gaps(2_000, 5 * MINUTE),
        idleMs: 4 * MINUTE,
        prefixTokens: 200_000,
      }).returnProbability;

    // Each of this conversation's slow replies moves 1% of the weight, even
    // though the global list is much longer. A few gaps move it little.
    expect(returnProbability(20)).toBeCloseTo(0.8);
    expect(returnProbability(50)).toBeCloseTo(0.5);
  });

  it("counts idle periods with no reply and stops at the idle horizon", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      prefixTokens: 200_000,
    };
    // Only 3 of 100 idle periods got a reply. If the 97 periods with no reply
    // had replies after 7 minutes too, Junior would warm.
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: [...gaps(3, 7 * MINUTE), ...gaps(97, NO_REPLY_GAP_MS)],
        idleMs: 4 * MINUTE,
      }),
    ).toMatchObject({ warm: false, reason: "unlikely_return" });
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: gaps(100, 7 * MINUTE),
        idleMs: 4 * MINUTE,
      }),
    ).toMatchObject({ warm: true });
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: gaps(100, 56 * MINUTE),
        idleMs: 55 * MINUTE,
      }),
    ).toMatchObject({ warm: false, reason: "horizon" });
  });

  it("uses the cache TTL of the model", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      prefixTokens: 200_000,
      // 30 of 100 idle periods get a reply after 40 minutes.
      globalGapsMs: [...gaps(30, 40 * MINUTE), ...gaps(70, NO_REPLY_GAP_MS)],
    };

    // A 5-minute cache at 4 minutes: no reply comes in the next 5 minutes.
    expect(decideWarmup({ ...input, idleMs: 4 * MINUTE })).toMatchObject({
      warm: false,
      reason: "unlikely_return",
    });
    // A 30-minute cache at 28 minutes: the replies at 40 minutes come before
    // it expires.
    const long = { ...input, cacheTtlMs: 30 * MINUTE };
    expect(decideWarmup({ ...long, idleMs: 28 * MINUTE })).toMatchObject({
      warm: true,
    });
    // Near the horizon, only replies before the horizon count.
    expect(decideWarmup({ ...long, idleMs: 50 * MINUTE })).toMatchObject({
      warm: false,
      reason: "unlikely_return",
    });
  });

  it("warms for returns a few TTLs away", () => {
    // People return after 10 minutes. One warmup at 4 minutes keeps the cache
    // only until 9 minutes, but a second warmup reaches them.
    const decision = decideWarmup({
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: gaps(100, 10 * MINUTE),
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    });

    expect(decision.returnProbability).toBe(0);
    expect(decision).toMatchObject({ warm: true, reason: "warm" });
  });

  it("gives no credit for returns that the current cache still covers", () => {
    // People reply at 4:30, before the current cache expires at 5:00. A
    // warmup at 4:15 saves no write for them.
    const decision = decideWarmup({
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: [...gaps(20, 4.5 * MINUTE), ...gaps(80, NO_REPLY_GAP_MS)],
      idleMs: 4.25 * MINUTE,
      cacheExpiryIdleMs: 5 * MINUTE,
      prefixTokens: 200_000,
    });

    expect(decision).toMatchObject({ warm: false, reason: "unlikely_return" });
  });

  it("counts warmups every TTL minus the margin in a plan", () => {
    // A warmup runs 45 seconds before expiry, so warmups come every 255
    // seconds. A plan that reaches replies 20 minutes out costs more warmups
    // than one 5-minute step each would count, and then it does not pay.
    const decision = decideWarmup({
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: [...gaps(23, 20 * MINUTE), ...gaps(77, NO_REPLY_GAP_MS)],
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    });

    expect(decision).toMatchObject({ warm: false, reason: "unlikely_return" });
  });

  it("uses one threshold for each warmup and stops when returns get rare", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      // Half of the idle periods get a reply after 6 minutes. The other half
      // get no reply, so after 7 minutes nobody is left to return.
      globalGapsMs: [...gaps(50, 6 * MINUTE), ...gaps(50, NO_REPLY_GAP_MS)],
      prefixTokens: 200_000,
    };

    const first = decideWarmup({ ...input, idleMs: 4 * MINUTE });
    expect(first).toMatchObject({ warm: true });
    // Earlier warmups are already paid: read / (write - read).
    expect(first.threshold).toBeCloseTo(0.2 / 4.8);
    const later = decideWarmup({ ...input, idleMs: 9 * MINUTE });
    expect(later).toMatchObject({ warm: false, reason: "unlikely_return" });
    expect(later.threshold).toBeCloseTo(first.threshold);
    expect(
      decideWarmup({
        ...input,
        idleMs: 4 * MINUTE,
        cacheReadPrice: 1,
        cacheWritePrice: 1,
      }),
    ).toMatchObject({ warm: false, reason: "no_savings" });
  });

  it("does not warm a small prefix or with too few observed gaps", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      idleMs: 4 * MINUTE,
    };

    expect(
      decideWarmup({
        ...input,
        globalGapsMs: gaps(100, 7 * MINUTE),
        prefixTokens: 20_000,
      }),
    ).toMatchObject({ warm: false, reason: "prefix_too_small" });
    expect(
      decideWarmup({ ...input, globalGapsMs: [], prefixTokens: 200_000 }),
    ).toMatchObject({ warm: false, reason: "few_gaps" });
    // One gap must not set the return chance of a whole segment.
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: [6 * MINUTE],
        prefixTokens: 200_000,
      }),
    ).toMatchObject({ warm: false, reason: "few_gaps" });
  });

  it("leans on the parent segment only while the segment is thin", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    };

    // A new segment warms with the return chances of its parent.
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: [6 * MINUTE],
        parentGapsMs: gaps(100, 7 * MINUTE),
      }),
    ).toMatchObject({ warm: true, reason: "warm", parentPrior: true });
    // A thin parent does not make enough gaps either.
    expect(
      decideWarmup({
        ...input,
        globalGapsMs: [6 * MINUTE],
        parentGapsMs: gaps(5, 7 * MINUTE),
      }),
    ).toMatchObject({ warm: false, reason: "few_gaps", parentPrior: true });
    // A full segment decides alone.
    const full = { ...input, globalGapsMs: gaps(20, 3 * 60 * MINUTE) };
    const withParent = decideWarmup({
      ...full,
      parentGapsMs: gaps(100, 7 * MINUTE),
    });
    expect(withParent).toMatchObject({
      warm: false,
      reason: "unlikely_return",
      parentPrior: false,
    });
    expect(withParent).toEqual(decideWarmup(full));
  });
});

describe("parentGapSegment", () => {
  it("picks the none segment with the same Actor and Turn depth", () => {
    const turn = { userActor: true, endedTurns: 1 };

    expect(
      parentGapSegment({ ...turn, workState: "open", archived: false }),
    ).toBe("user:2-3:none");
    expect(
      parentGapSegment({ ...turn, workState: "done", archived: true }),
    ).toBe("user:2-3:none");
    expect(
      parentGapSegment({ ...turn, workState: "none", archived: true }),
    ).toBe("user:2-3:none");
    expect(
      parentGapSegment({ ...turn, workState: "none", archived: false }),
    ).toBeUndefined();
  });
});

describe("warmupFailureCountsAsMiss", () => {
  it("counts provider rejections but not retryable failures", () => {
    // The messages that Pi reports for Anthropic errors.
    const overloaded = createProviderError(
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    );
    const rateLimited = createProviderError(
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}',
    );
    const rejected = createProviderError(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Bad cache_control"}}',
    );

    expect(warmupFailureCountsAsMiss(overloaded)).toBe(false);
    expect(warmupFailureCountsAsMiss(rateLimited)).toBe(false);
    expect(warmupFailureCountsAsMiss(rejected)).toBe(true);
  });
});
