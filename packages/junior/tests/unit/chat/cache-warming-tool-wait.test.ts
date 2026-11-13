import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import { createJuniorApi } from "@/api";
import { cacheWarmingSavingsReportSchema } from "@/api/schema";
import { NO_REPLY_GAP_MS } from "@/chat/cache-warming/model";
import type { ModelRequest } from "@/chat/cache-warming/request";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";

const mocks = vi.hoisted(() => ({
  sendWarmup: vi.fn(async () => ({
    refreshed: true,
    costUsd: 0.05,
    attributes: {},
  })),
}));

vi.mock("@/chat/cache-warming/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/request")>()),
  sendWarmup: mocks.sendWarmup,
}));

const { createToolWaitWarmer } = await import("@/chat/cache-warming/tool-wait");

const MINUTE = 60_000;
const GAPS_KEY = "junior:cache_warming:gaps:tool_wait";
const OPEN_WAIT_KEY =
  "junior:cache_warming:tool_wait:open:local:test:tool-wait";
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
    await getStateAdapter().delete(OPEN_WAIT_KEY);
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

  it("warms for tools that return a few TTLs later", async () => {
    // Tools return after 10 minutes. A return in the next TTL is not likely
    // at the first warmup, but a chain of warmups reaches it.
    await seedToolWaits(10 * MINUTE);
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));

    await vi.advanceTimersByTimeAsync(30 * MINUTE);

    // At about 4, 8, and 12 minutes. At 16 minutes, every tool returned.
    expect(mocks.sendWarmup).toHaveBeenCalledTimes(3);
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

  it("does not warm after a request that outlived its cache", async () => {
    await seedToolWaits(8 * MINUTE);
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    // The request generated for 6 minutes, so its cache already expired.
    await warmer.record(
      { ...request(), startedAtMs: Date.now() - 6 * MINUTE },
      message("toolUse"),
    );
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(mocks.sendWarmup).not.toHaveBeenCalled();
    warmer.stop();
  });

  it("stops when the run ends, also during a warmup", async () => {
    await seedToolWaits(8 * MINUTE);
    let finishWarmup = () => {};
    mocks.sendWarmup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWarmup = () =>
            resolve({ refreshed: true, costUsd: 0.05, attributes: {} });
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

  it("counts the warmup cost and the savings of a warmed tool wait", async () => {
    // A day of its own, so the waits of the other cases do not count.
    vi.setSystemTime(new Date("2031-04-01T12:00:00.000Z"));
    await seedToolWaits(8 * MINUTE);
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));
    // One warmup at about 4 minutes keeps the cache until the tool returns.
    await vi.advanceTimersByTimeAsync(7 * MINUTE);
    expect(mocks.sendWarmup).toHaveBeenCalledTimes(1);
    await warmer.record(request(), message("stop"));

    const response = await createJuniorApi().request(
      "http://localhost/api/cache-warming/savings?days=1",
    );
    const { totals } = cacheWarmingSavingsReportSchema.parse(
      await response.json(),
    );
    // Prices are per million tokens. The 7-minute wait needs one warmup.
    const read = (60_000 * model.cost.cacheRead) / 1_000_000;
    const write = (60_000 * model.cost.cacheWrite) / 1_000_000;
    const close = (usd: number) => expect.closeTo(usd, 3);
    expect(totals).toMatchObject({
      idlePeriods: 1,
      hits: 1,
      savedUsd: close(write - read),
      warmupCostUsd: close(0.05),
      oracleSavingsUsd: close(write - 2 * read),
      unwarmedIdlePeriods: 0,
    });
  });

  it("counts the savings of a tool wait that a slice yield cut off", async () => {
    // A day of its own, so the waits of the other cases do not count.
    vi.setSystemTime(new Date("2031-04-02T12:00:00.000Z"));
    const yielded = createToolWaitWarmer("local:test:tool-wait");
    await yielded.record(request(), message("toolUse"));
    vi.advanceTimersByTime(6 * MINUTE);
    yielded.toolsReturned();
    await yielded.end();
    // The next slice is a new run, and its first request reads the cache.
    vi.advanceTimersByTime(MINUTE);
    const resumed = createToolWaitWarmer("local:test:tool-wait");
    await resumed.record(request(), message("stop"));

    const response = await createJuniorApi().request(
      "http://localhost/api/cache-warming/savings?days=1",
    );
    const { totals } = cacheWarmingSavingsReportSchema.parse(
      await response.json(),
    );
    const read = (60_000 * model.cost.cacheRead) / 1_000_000;
    const write = (60_000 * model.cost.cacheWrite) / 1_000_000;
    expect(totals).toMatchObject({
      idlePeriods: 1,
      hits: 1,
      savedUsd: expect.closeTo(write - read, 3),
    });
  });

  it("records only tool waits that can change a decision", async () => {
    const warmer = createToolWaitWarmer("local:test:tool-wait");
    await warmer.record(request(), message("toolUse"));
    vi.advanceTimersByTime(30_000);
    await warmer.record(request(), message("toolUse"));
    vi.advanceTimersByTime(3 * MINUTE);
    await warmer.record(request(), message("stop"));
    await warmer.end();

    expect(await getStateAdapter().getList<number>(GAPS_KEY)).toEqual([
      3 * MINUTE,
    ]);
  });

  it("records a wait that the run end cut off as no return, and one whose tools returned as its wait", async () => {
    const short = createToolWaitWarmer("local:test:tool-wait");
    await short.record(request(), message("toolUse"));
    vi.advanceTimersByTime(30_000);
    await short.end();
    const long = createToolWaitWarmer("local:test:tool-wait");
    await long.record(request(), message("toolUse"));
    vi.advanceTimersByTime(3 * MINUTE);
    await long.end();

    // The tools returned after 6 minutes, and the run yielded before the
    // next request.
    const yielded = createToolWaitWarmer("local:test:tool-wait");
    await yielded.record(request(), message("toolUse"));
    vi.advanceTimersByTime(6 * MINUTE);
    yielded.toolsReturned();
    vi.advanceTimersByTime(MINUTE);
    await yielded.end();

    expect(await getStateAdapter().getList<number>(GAPS_KEY)).toEqual([
      NO_REPLY_GAP_MS,
      6 * MINUTE,
    ]);
  });
});
