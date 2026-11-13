import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
  breakerOpen,
  connectedState,
  sendWarmup,
} from "@/chat/cache-warming/request";
import { mockTitleModel } from "../../fixtures/title-model";

const MINUTE = 60_000;
const modelId = "anthropic/claude-opus-5.5";
const OUTCOMES_KEY = "junior:cache_warming:breaker:anthropic:outcomes";
const OPEN_KEY = "junior:cache_warming:breaker:anthropic:open";
const context: Context = {
  systemPrompt: "Answer briefly.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};

async function warm(cacheReadTokens: number) {
  mockTitleModel("", { cacheReadTokens });
  const state = await connectedState();
  return sendWarmup(state, {
    conversationId: "local:test:cache-warming-breaker",
    modelId,
    context,
    prefixTokens: 60_000,
  });
}

describe("cache warming breaker", () => {
  afterEach(async () => {
    vi.useRealTimers();
    const state = await connectedState();
    await state.delete(OUTCOMES_KEY);
    await state.delete(OPEN_KEY);
  });

  it("pauses warming briefly after a burst of misses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = await connectedState();
    for (let i = 0; i < 9; i++) {
      expect((await warm(0)).refreshed).toBe(false);
    }
    expect(await breakerOpen(state, modelId)).toBe(false);

    await warm(0);
    expect(await breakerOpen(state, modelId)).toBe(true);
    // A provider that stays broken must miss again to reopen the breaker.
    expect(await state.getList(OUTCOMES_KEY)).toEqual([]);

    vi.advanceTimersByTime(31 * MINUTE);
    expect(await breakerOpen(state, modelId)).toBe(false);
    // One more miss after the pause does not reopen it.
    await warm(0);
    expect(await breakerOpen(state, modelId)).toBe(false);
  });
});
