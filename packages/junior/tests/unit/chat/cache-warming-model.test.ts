import { describe, expect, it } from "vitest";
import { decideWarmup } from "@/chat/cache-warming/model";

const MINUTE = 60_000;
// Anthropic Opus prices in $/MTok.
const prices = { cacheReadPrice: 0.2, cacheWritePrice: 5 };

function gaps(count: number, gapMs: number): number[] {
  return Array.from({ length: count }, () => gapMs);
}

describe("decideWarmup", () => {
  it("warms when people usually reply within the next cache TTL", () => {
    const decision = decideWarmup({
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: [...gaps(80, 7 * MINUTE), ...gaps(20, 3 * 60 * MINUTE)],
      idleMs: 4 * MINUTE,
      cycle: 1,
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
      conversationGapsMs: gaps(20, 3 * 60 * MINUTE),
      globalGapsMs: gaps(100, 7 * MINUTE),
      idleMs: 4 * MINUTE,
      cycle: 1,
      prefixTokens: 200_000,
    });

    expect(decision).toMatchObject({ warm: false, reason: "unlikely_return" });
  });

  it("raises the threshold with each warmup until warming cannot pay", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      globalGapsMs: gaps(100, 7 * MINUTE),
      idleMs: 4 * MINUTE,
      prefixTokens: 200_000,
    };

    expect(decideWarmup({ ...input, cycle: 2 }).threshold).toBeCloseTo(
      2 * decideWarmup({ ...input, cycle: 1 }).threshold,
    );
    // (5 - 0.2) / 0.2 = 24 warmups cost as much as one cache write.
    expect(decideWarmup({ ...input, cycle: 24 })).toMatchObject({
      warm: false,
      reason: "cycle_limit",
    });
  });

  it("does not warm a small prefix or without any observed gaps", () => {
    const input = {
      ...prices,
      conversationGapsMs: [],
      idleMs: 4 * MINUTE,
      cycle: 1,
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
    ).toMatchObject({ warm: false, reason: "unlikely_return" });
  });
});
