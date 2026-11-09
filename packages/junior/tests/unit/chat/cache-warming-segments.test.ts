import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

const { createCacheWarmingRecorder, runCacheWarmup } =
  await import("@/chat/cache-warming/warmup");

const MINUTE = 60_000;
const conversationId = "local:test:cache-warming-segments";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const context: Context = {
  systemPrompt: "Answer the question.",
  messages: [{ role: "user", content: "Hi.", timestamp: 1 }],
};
const finalReply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  api: "anthropic-messages",
  provider: "vercel-ai-gateway",
  model: model.id,
  usage: {
    input: 10,
    output: 10,
    cacheRead: 60_000,
    cacheWrite: 0,
    totalTokens: 60_020,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
};

// Run one Turn that ends with a final reply, like one agent run does.
async function endTurn(userActor: boolean) {
  const recorder = createCacheWarmingRecorder(conversationId, userActor);
  recorder.wrap((() => undefined) as never)(model, context, {});
  await recorder.record(finalReply);
}

function scheduledHorizon(): CacheWarmupMessage {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent) => sent.kind === "horizon");
  if (!message) throw new Error("No horizon message was scheduled.");
  return message;
}

const segmentGaps = (segment: string) =>
  getStateAdapter().getList<number>(`junior:cache_warming:gaps:${segment}`);

describe("cache warming gap segments", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await getStateAdapter().delete(
      `junior:cache_warming:conversation:${conversationId}`,
    );
  });

  it("records each gap in the segment of the Turn that started the idle period", async () => {
    vi.useFakeTimers();
    await endTurn(false);
    // Nobody returned within the idle horizon of the first Turn.
    vi.advanceTimersByTime(56 * MINUTE);
    await runCacheWarmup(scheduledHorizon());

    // A person starts the second Turn and returns 7 minutes after it ends.
    await endTurn(true);
    vi.advanceTimersByTime(7 * MINUTE);
    await endTurn(true);

    expect(await segmentGaps("system:1")).toEqual([NO_REPLY_GAP_MS]);
    expect(await segmentGaps("user:2-3")).toEqual([7 * MINUTE]);
    expect(await segmentGaps("user:1")).toEqual([]);
  });

  it("does not record a no-reply gap after a reply recorded the real gap", async () => {
    vi.useFakeTimers();
    await endTurn(true);
    const horizon = scheduledHorizon();
    vi.advanceTimersByTime(7 * MINUTE);

    // The person replies right after the horizon message reads the idle
    // period, before it records the no-reply gap.
    const state = getStateAdapter();
    const get = state.get.bind(state);
    vi.spyOn(state, "get").mockImplementationOnce(async (key) => {
      const value = await get(key);
      await endTurn(true);
      return value;
    });
    await runCacheWarmup(horizon);

    expect(await segmentGaps("user:1")).toEqual([7 * MINUTE]);
  });

  it("drops a warmup that arrives after the cache expired without counting a miss", async () => {
    vi.useFakeTimers();
    const state = getStateAdapter();
    // People in this segment reply after 8 minutes, so the model would warm.
    for (let i = 0; i < 20; i++) {
      await state.appendToList("junior:cache_warming:gaps:user:1", 8 * MINUTE);
    }
    mocks.sendCacheWarmup.mockClear();
    await endTurn(true);
    const warmup = mocks.sendCacheWarmup.mock.calls
      .map(([sent]) => sent as CacheWarmupMessage)
      .find((sent) => sent.kind === "warmup");
    if (!warmup) throw new Error("No warmup was scheduled.");

    // The queue delivers the warmup after the 5 minute cache expired.
    vi.advanceTimersByTime(6 * MINUTE);
    await runCacheWarmup(warmup);

    expect(
      await state.getList<number>(
        "junior:cache_warming:breaker:anthropic:outcomes",
      ),
    ).toEqual([]);
    await state.delete("junior:cache_warming:gaps:user:1");
  });

  it("schedules the horizon when the warmup send fails", async () => {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList("junior:cache_warming:gaps:user:1", 8 * MINUTE);
    }
    mocks.sendCacheWarmup.mockClear();
    mocks.sendCacheWarmup.mockImplementation(async (message: unknown) => {
      if ((message as CacheWarmupMessage).kind === "warmup") {
        throw new Error("queue unavailable");
      }
    });
    try {
      await endTurn(true);
      expect(scheduledHorizon().conversationId).toBe(conversationId);
    } finally {
      mocks.sendCacheWarmup.mockImplementation(async () => {});
      await state.delete("junior:cache_warming:gaps:user:1");
    }
  });

  it("warms only short-retention requests of fixed-TTL caches whose write costs more than a read", async () => {
    const warmupsAfterTurn = async (
      modelId: string,
      cacheRetention?: "short" | "long",
    ) => {
      mocks.sendCacheWarmup.mockClear();
      await getStateAdapter().delete(
        `junior:cache_warming:conversation:${conversationId}`,
      );
      const base = vi.fn();
      const recorder = createCacheWarmingRecorder(conversationId, true);
      recorder.wrap(base as never)(
        resolveGatewayModel(modelId),
        context,
        cacheRetention ? { cacheRetention } : {},
      );
      await recorder.record({ ...finalReply, model: modelId });
      const warmup = mocks.sendCacheWarmup.mock.calls
        .map(([sent]) => sent as CacheWarmupMessage)
        .find((sent) => sent.kind === "warmup");
      return {
        sentRetention: base.mock.calls[0]?.[2]?.cacheRetention,
        warmups: mocks.sendCacheWarmup.mock.calls.length,
        ttlMinutes: warmup
          ? Math.round((warmup.cacheExpiresAtMs - Date.now()) / 60_000)
          : undefined,
      };
    };

    // The warmup and the horizon message.
    expect(await warmupsAfterTurn("anthropic/claude-opus-5.5")).toEqual({
      sentRetention: "short",
      warmups: 2,
      ttlMinutes: 5,
    });
    expect(await warmupsAfterTurn("alibaba/qwen3.7-plus")).toMatchObject({
      warmups: 2,
      ttlMinutes: 5,
    });
    // OpenAI's cache lasts 30 minutes, so its warmup is due later.
    expect(await warmupsAfterTurn("openai/gpt-5.6-sol")).toMatchObject({
      warmups: 2,
      ttlMinutes: 30,
    });
    // The cache write has no price of its own, so the model skips it.
    expect(await warmupsAfterTurn("openai/gpt-5.5")).toMatchObject({
      warmups: 0,
    });
    expect(
      await warmupsAfterTurn("anthropic/claude-opus-5.5", "long"),
    ).toMatchObject({ sentRetention: "long", warmups: 0 });
  });
});
