import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHILD_WAIT_IDLE_HORIZON_MS,
  IDLE_HORIZON_MS,
  NO_REPLY_GAP_MS,
} from "@/chat/cache-warming/model";
import { cancelWatch, createTimerWatch } from "@/chat/events/store";
import { getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";
import { runCacheWarmup } from "@/chat/cache-warming/warmup";
import {
  MINUTE,
  conversationId,
  context,
  timerConversationId,
  parentConversationId,
  endTurn,
  toolCall,
  startChildAgent,
  scheduledHorizon,
  scheduledWarmup,
  segmentGaps,
  runIdleWarmups,
} from "../../fixtures/cache-warming-idle";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

describe("cache warming of idle periods that wait on other work", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of [
      conversationId,
      timerConversationId,
      parentConversationId,
    ]) {
      await getStateAdapter().delete(`junior:cache_warming:conversation:${id}`);
    }
  });

  it("keeps warming past the horizon until a timer due within the floor fires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = getStateAdapter();
    mocks.sendCacheWarmup.mockClear();
    mockTitleModel("", { cacheReadTokens: 60_000 });
    const timer = await createTimerWatch({
      conversationId: timerConversationId,
      toolCallId: "timer-80",
      afterMs: 80 * MINUTE,
      intent: "Check the deploy.",
    });
    try {
      const sinceMs = Date.now();
      // The segment has no gaps, so without the timer nothing warms.
      await endTurn(true, timerConversationId);
      const warmups = await runIdleWarmups(sinceMs);

      expect(warmups.at(-1)).toBeGreaterThan(IDLE_HORIZON_MS);
      // The last warmup keeps the cache until the timer's Turn starts.
      expect(warmups.at(-1)! + 5 * MINUTE).toBeGreaterThan(82 * MINUTE);
      expect(warmups.at(-1)).toBeLessThan(82 * MINUTE);
      // The next warmup stops the idle period.
      expect(
        await state.get(
          `junior:cache_warming:snapshot:${timerConversationId}:${scheduledWarmup().generation}`,
        ),
      ).toBeNull();
      // The horizon still records the no-reply gap.
      expect(await segmentGaps("user:1:none")).toEqual([NO_REPLY_GAP_MS]);
    } finally {
      await cancelWatch({ conversationId: timerConversationId, id: timer.id });
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });

  it("warms an idle period with a timer due after the floor as without the timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = getStateAdapter();
    mockTitleModel("", { cacheReadTokens: 60_000 });
    const warmupsAfterTurn = async () => {
      mocks.sendCacheWarmup.mockClear();
      await state.delete(
        `junior:cache_warming:conversation:${timerConversationId}`,
      );
      await state.delete("junior:cache_warming:gaps:user:1:none");
      // People in this segment reply after 8 minutes.
      for (let i = 0; i < 20; i++) {
        await state.appendToList(
          "junior:cache_warming:gaps:user:1:none",
          8 * MINUTE,
        );
      }
      const sinceMs = Date.now();
      await endTurn(true, timerConversationId);
      return await runIdleWarmups(sinceMs);
    };
    const withoutTimer = await warmupsAfterTurn();
    const timer = await createTimerWatch({
      conversationId: timerConversationId,
      toolCallId: "timer-150",
      afterMs: 150 * MINUTE,
      intent: "Check the deploy.",
    });
    try {
      expect(withoutTimer.length).toBeGreaterThan(0);
      expect(await warmupsAfterTurn()).toEqual(withoutTimer);
    } finally {
      await cancelWatch({ conversationId: timerConversationId, id: timer.id });
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });

  it("records the gap of an idle period that waits on a child agent or an Inbox item in the segment's child", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = getStateAdapter();
    // People reply after 8 minutes in the segment. Its children have no gaps
    // yet.
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    mocks.sendCacheWarmup.mockClear();
    const warmupRequests: unknown[] = [];
    mockTitleModel("", {
      cacheReadTokens: 60_000,
      onRequest: (request) => warmupRequests.push(request),
    });
    try {
      // The Turn started a child agent, which still runs.
      await startChildAgent();
      await endTurn(true, parentConversationId);
      // The thin child segment warms with the gaps of its segment.
      await runCacheWarmup(scheduledWarmup());
      expect(warmupRequests).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2 * MINUTE);
      await endTurn(true, parentConversationId);

      // Another Turn asked an Inbox item.
      await endTurn(true, conversationId, {
        ...context,
        messages: [...context.messages, toolCall("askUserQuestion")],
      });
      vi.setSystemTime(Date.now() + 3 * MINUTE);
      await endTurn(true, conversationId);

      expect(await segmentGaps("user:1:none:child")).toEqual([2 * MINUTE]);
      expect(await segmentGaps("user:1:none:review")).toEqual([3 * MINUTE]);
      // The segment keeps every gap, so its children can lean on it.
      expect((await segmentGaps("user:1:none")).slice(20)).toEqual([
        2 * MINUTE,
        3 * MINUTE,
      ]);
      // The Conversation keeps the child's return apart from a person's.
      const conversationGaps = (segment: string) =>
        state.getList<number>(
          `junior:cache_warming:gaps:conversation:${parentConversationId}:${segment}`,
        );
      expect(await conversationGaps("user:1:none:child")).toEqual([2 * MINUTE]);
      expect(await conversationGaps("user:1:none")).toEqual([]);
    } finally {
      for (const segment of [
        "user:1:none",
        "user:1:none:child",
        "user:1:none:review",
      ]) {
        await state.delete(`junior:cache_warming:gaps:${segment}`);
        for (const id of [conversationId, parentConversationId]) {
          await state.delete(
            `junior:cache_warming:gaps:conversation:${id}:${segment}`,
          );
        }
      }
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });

  it("keeps warming a child agent wait past the default horizon while its returns pay", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const state = getStateAdapter();
    // Child agents in this segment return after 70 minutes.
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none:child",
        70 * MINUTE,
      );
    }
    mocks.sendCacheWarmup.mockClear();
    mockTitleModel("", { cacheReadTokens: 60_000 });
    try {
      await startChildAgent();
      const sinceMs = Date.now();
      await endTurn(true, parentConversationId);
      const warmups = await runIdleWarmups(sinceMs);

      expect(warmups.at(-1)).toBeGreaterThan(70 * MINUTE);
      expect(warmups.at(-1)).toBeLessThan(CHILD_WAIT_IDLE_HORIZON_MS);
      // The first horizon sent the second step, which ends at the child
      // wait's horizon. Each step arrives within the signature age.
      const horizon = scheduledHorizon();
      expect(horizon).toMatchObject({ step: 2 });
      const [, delayMs] = mocks.sendCacheWarmup.mock.calls.find(
        ([sent]) => sent === horizon,
      )!;
      expect(delayMs).toBeLessThanOrEqual(IDLE_HORIZON_MS);

      // The child's result returns after warming stopped. The segment
      // records it as no reply, as its other idle periods would.
      vi.setSystemTime(sinceMs + 100 * MINUTE);
      await endTurn(true, parentConversationId);
      await runCacheWarmup(horizon);
      expect((await segmentGaps("user:1:none:child")).slice(20)).toEqual([
        100 * MINUTE,
      ]);
      expect(await segmentGaps("user:1:none")).toEqual([NO_REPLY_GAP_MS]);
    } finally {
      for (const segment of ["user:1:none", "user:1:none:child"]) {
        await state.delete(`junior:cache_warming:gaps:${segment}`);
        await state.delete(
          `junior:cache_warming:gaps:conversation:${parentConversationId}:${segment}`,
        );
      }
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });
});
