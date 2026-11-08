import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { ModelRequest } from "@/chat/cache-warming/request";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";

const mocks = vi.hoisted(() => ({
  sendWarmup: vi.fn(async () => ({ refreshed: true, attributes: {} })),
}));

vi.mock("@/chat/cache-warming/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/request")>()),
  sendWarmup: mocks.sendWarmup,
}));

const { createToolWaitWarmer } = await import("@/chat/cache-warming/tool-wait");

const MINUTE = 60_000;
const GAPS_KEY = "junior:cache_warming:gaps:tool_wait";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const context: Context = {
  systemPrompt: "Answer from the lookup result.",
  messages: [{ role: "user", content: "Look it up.", timestamp: 1 }],
};

function message(
  stopReason: AssistantMessage["stopReason"],
  cacheRead = 60_000,
): AssistantMessage {
  return {
    role: "assistant",
    content:
      stopReason === "toolUse"
        ? [{ type: "toolCall", id: "call-1", name: "lookup", arguments: {} }]
        : [{ type: "text", text: "Done." }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: model.id,
    usage: {
      input: 10,
      output: 10,
      cacheRead,
      cacheWrite: 0,
      totalTokens: cacheRead + 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function request(): ModelRequest {
  return {
    model,
    context,
    cacheRetention: "short",
    startedAtMs: Date.now(),
  };
}

async function seedToolWaits(waitMs: number) {
  const state = getStateAdapter();
  await state.connect();
  for (let i = 0; i < 20; i++) {
    await state.appendToList(GAPS_KEY, waitMs);
  }
}

describe("tool wait cache warming", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.sendWarmup.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await getStateAdapter().delete(GAPS_KEY);
  });

  it("warms while recorded tool waits say the tool returns soon", async () => {
    // Tools that run this long usually return after 8 minutes.
    await seedToolWaits(8 * MINUTE);
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));

    await vi.advanceTimersByTimeAsync(30 * MINUTE);

    // At about 4 and 7.5 minutes a return in the next 5 minutes is likely.
    // At about 11 minutes, every recorded tool has returned.
    expect(mocks.sendWarmup).toHaveBeenCalledTimes(2);
    expect(mocks.sendWarmup).toHaveBeenCalledWith(expect.anything(), {
      conversationId: "local:test:tool-wait",
      modelId: model.id,
      context,
      prefixTokens: 60_000,
    });
    warmer.stop();
  });

  it("does not warm without recorded tool waits or for a small prefix", async () => {
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await seedToolWaits(8 * MINUTE);
    await warmer.record(request(), message("toolUse", 1_000));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    expect(mocks.sendWarmup).not.toHaveBeenCalled();
    warmer.stop();
  });

  it("stops when the run ends, also during a warmup", async () => {
    await seedToolWaits(8 * MINUTE);
    let finishWarmup = () => {};
    mocks.sendWarmup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWarmup = () => resolve({ refreshed: true, attributes: {} });
        }),
    );
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(mocks.sendWarmup).toHaveBeenCalledTimes(1);
    warmer.stop();
    finishWarmup();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(mocks.sendWarmup).toHaveBeenCalledTimes(1);
  });

  it("records only tool waits that can change a decision", async () => {
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));
    vi.advanceTimersByTime(30_000);
    await warmer.record(request(), message("toolUse"));
    vi.advanceTimersByTime(3 * MINUTE);
    await warmer.record(request(), message("stop"));
    warmer.stop();

    expect(await getStateAdapter().getList<number>(GAPS_KEY)).toEqual([
      3 * MINUTE,
    ]);
  });
});
