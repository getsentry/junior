import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import type { Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { createJuniorApi } from "@/api";
import { setConversationArchive } from "@/api/conversations/archive";
import { cacheWarmingSavingsReportSchema } from "@/api/schema";
import { NO_REPLY_GAP_MS, WARMUP_MARGIN_MS } from "@/chat/cache-warming/model";
import { getConversationStore } from "@/chat/db";
import {
  cancelWatch,
  createTimerWatch,
  createWatch,
} from "@/chat/events/store";
import { createApp } from "@/app";
import { defineJuniorPlugins } from "@/plugins";
import { resolveGatewayModel } from "@/chat/pi/client";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";
import { createCacheWarmingRecorder } from "@/chat/cache-warming/recorder";
import { runCacheWarmup } from "@/chat/cache-warming/warmup";
import {
  MINUTE,
  conversationId,
  workConversationId,
  childConversationId,
  openWorkConversationId,
  parentConversationId,
  automationConversationId,
  model,
  context,
  finalReply,
  definitionsKey,
  turnOf,
  endTurn,
  endTurnWithAnswerTool,
  startChildAgent,
  scheduledHorizon,
  scheduledWarmup,
  segmentGaps,
} from "../../fixtures/cache-warming-idle";

const mocks = vi.hoisted(() => ({
  sendCacheWarmup: vi.fn(async (_message: unknown, _delayMs: number) => {}),
}));

vi.mock("@/chat/cache-warming/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/cache-warming/queue")>()),
  sendCacheWarmup: mocks.sendCacheWarmup,
}));

describe("cache warming gap segments", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Start the next test with empty state, so gaps that a test records do
    // not reach the segments of the next test.
    await disconnectStateAdapter();
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

    expect(await segmentGaps("system:1:none")).toEqual([NO_REPLY_GAP_MS]);
    expect(await segmentGaps("user:2-3:none")).toEqual([7 * MINUTE]);
    expect(await segmentGaps("user:1:none")).toEqual([]);
    // The Conversation's own gaps are kept per segment too.
    expect(
      await segmentGaps(`conversation:${conversationId}:system:1:none`),
    ).toEqual([NO_REPLY_GAP_MS]);
    expect(
      await segmentGaps(`conversation:${conversationId}:user:2-3:none`),
    ).toEqual([7 * MINUTE]);
  });

  it.each(["reply", "noReply", "reportBlocked"])(
    "starts an idle period from the %s call of a child agent's Turn, not of an Automation run with no pending work",
    async (toolName) => {
      vi.useFakeTimers();
      mocks.sendCacheWarmup.mockClear();
      await endTurnWithAnswerTool(toolName, "automation");
      // A final response of an Automation run starts none either.
      await endTurn(false, conversationId, context, "automation");
      expect(mocks.sendCacheWarmup).not.toHaveBeenCalled();

      await endTurnWithAnswerTool(toolName, "child_agent");
      scheduledWarmup();
      // The parent returns 4 minutes after the answer tool call.
      vi.advanceTimersByTime(4 * MINUTE);
      await endTurn(false);

      expect(await segmentGaps("system:1:none")).toEqual([4 * MINUTE]);
    },
  );

  // A person's reply shares the `automation` Prompt mode with the run, but
  // it can get an answer, so it needs no pending work.
  it("starts an idle period from a person's reply in an Automation Conversation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mocks.sendCacheWarmup.mockClear();
    await endTurn(
      true,
      `${automationConversationId}:reply`,
      context,
      "automation",
    );

    expect(scheduledWarmup()).toBeDefined();
  });

  it.each(["timer", "child", "watch"] as const)(
    "starts an idle period from the ending of an Automation run with a pending %s",
    async (pending) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const state = getStateAdapter();
      mocks.sendCacheWarmup.mockClear();
      const id =
        pending === "child" ? parentConversationId : automationConversationId;
      const watch =
        pending === "timer"
          ? await createTimerWatch({
              conversationId: id,
              toolCallId: "automation-timer",
              afterMs: 30 * MINUTE,
              intent: "Check the deploy.",
            })
          : pending === "watch"
            ? // Like the pull request Watch that `createPullRequest` adds.
              await createWatch({
                conversationId: id,
                events: ["pull_request.merged"],
                expiresAtMs: Date.now() + 60 * MINUTE,
                intent: "Report the merge.",
                label: "Pull request",
                namespace: "github",
                identifier: "getsentry/junior#1",
                resourceType: "pull_request",
              })
            : undefined;
      if (pending === "child") await startChildAgent();
      const segment = `system:1:none:${pending === "child" ? "child" : "automation"}`;
      try {
        await endTurn(false, id, context, "automation");
        scheduledWarmup();
        // The Watch or the child's result starts a Turn 4 minutes later.
        vi.setSystemTime(Date.now() + 4 * MINUTE);
        await endTurn(false, id);

        expect(await segmentGaps(segment)).toEqual([4 * MINUTE]);
        expect(await segmentGaps("system:1:none")).toEqual([4 * MINUTE]);
      } finally {
        if (watch) await cancelWatch({ conversationId: id, id: watch.id });
        for (const key of [segment, "system:1:none"]) {
          await state.delete(`junior:cache_warming:gaps:${key}`);
          await state.delete(
            `junior:cache_warming:gaps:conversation:${id}:${key}`,
          );
        }
      }
    },
  );

  it("records each gap in the segment of the plugin work and archive state when the idle period started", async () => {
    vi.useFakeTimers();
    let work: { open: boolean; finishedAt: Record<string, string> } = {
      open: false,
      finishedAt: {
        [workConversationId]: new Date(Date.now() - MINUTE).toISOString(),
      },
    };
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Cache warming work test plugin",
          },
          hooks: {
            unfinishedWork: () => ({
              assignedConversationIds: [workConversationId],
              conversationIds: work.open ? [workConversationId] : [],
              finishedWorkAtByConversationId: work.finishedAt,
            }),
          },
        }),
      ]),
    });
    const store = getConversationStore();
    await store.recordActivity({
      conversationId: workConversationId,
      destination: { platform: "local", conversationId: workConversationId },
      source: "internal",
    });

    // The pull request merged a minute before the Turn ended, and nobody
    // came back in the idle horizon.
    await endTurn(false, workConversationId);
    vi.advanceTimersByTime(56 * MINUTE);
    await runCacheWarmup(scheduledHorizon());

    // Junior opened another pull request, and the Conversation was archived.
    // Its CI result starts a Turn 3 minutes after the Turn ended.
    work = { open: true, finishedAt: {} };
    const conversation = await store.get({
      conversationId: workConversationId,
    });
    await setConversationArchive({
      applyToChildren: false,
      archived: true,
      conversationId: workConversationId,
      lastSeenAt: new Date(conversation!.lastActivityAtMs).toISOString(),
    });
    await endTurn(false, workConversationId);
    vi.advanceTimersByTime(3 * MINUTE);
    await endTurn(false, workConversationId);
    // A child that starts after the archive is not archived itself, like the
    // children of a root that auto-archive archived. It still counts as
    // archived.
    await store.createChild({
      childConversationId,
      kind: "task",
      parentConversationId: workConversationId,
    });
    await endTurn(false, childConversationId);
    vi.advanceTimersByTime(2 * MINUTE);
    await endTurn(false, childConversationId);

    expect(await segmentGaps("system:1:done")).toEqual([NO_REPLY_GAP_MS]);
    expect(await segmentGaps("archived:open")).toEqual([3 * MINUTE]);
    expect(await segmentGaps("archived:none")).toEqual([2 * MINUTE]);
    expect(await segmentGaps("system:2-3:open")).toEqual([]);
  });

  it("warms a segment with no gaps of its own with the gaps of its parent", async () => {
    const state = getStateAdapter();
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "open-work",
            displayName: "Open work",
            description: "Cache warming parent prior test plugin",
          },
          hooks: {
            unfinishedWork: () => ({
              assignedConversationIds: [openWorkConversationId],
              conversationIds: [openWorkConversationId],
              finishedWorkAtByConversationId: {},
            }),
          },
        }),
      ]),
    });
    await getConversationStore().recordActivity({
      conversationId: openWorkConversationId,
      destination: {
        platform: "local",
        conversationId: openWorkConversationId,
      },
      source: "internal",
    });
    // People reply after 8 minutes in the `none` segment. The `open`
    // segment has no gaps yet.
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    mocks.sendCacheWarmup.mockClear();
    try {
      // The model service answers the warmup with fixed text.
      const warmupRequests: unknown[] = [];
      mockTitleModel("", {
        onRequest: (request) => warmupRequests.push(request),
      });
      await endTurn(true, openWorkConversationId);
      await runCacheWarmup(scheduledWarmup());

      expect(await segmentGaps("user:1:open")).toEqual([]);
      // Without the parent's gaps, the empty segment would skip the warmup.
      expect(warmupRequests).toHaveLength(1);
    } finally {
      await state.delete("junior:cache_warming:gaps:user:1:none");
      // The warmup counted an outcome for the provider breaker.
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
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

    expect(await segmentGaps("user:1:none")).toEqual([7 * MINUTE]);
  });

  it("drops a warmup that arrives after the cache expired without counting a miss", async () => {
    vi.useFakeTimers();
    const state = getStateAdapter();
    // People in this segment reply after 8 minutes, so the model would warm.
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
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
    await state.delete("junior:cache_warming:gaps:user:1:none");
  });

  it("sends no warmup while the reply's first request runs", async () => {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    mocks.sendCacheWarmup.mockClear();
    try {
      await endTurn(true);
      const warmup = scheduledWarmup();
      // The person replies. The warmup comes due before the model call ends.
      const reply = createCacheWarmingRecorder(
        conversationId,
        turnOf(true),
        definitionsKey,
      );
      void reply.wrap((() => undefined) as never)(model, context, {});
      await vi.waitFor(async () => {
        expect(
          await state.get(
            `junior:cache_warming:snapshot:${conversationId}:${warmup.generation}`,
          ),
        ).toBeNull();
      });

      // With the snapshot gone, the warmup returns before any model request.
      await runCacheWarmup(warmup);
      await reply.record(finalReply);
      expect(
        await state.get(
          `junior:cache_warming:warmups:${conversationId}:${warmup.generation}`,
        ),
      ).toBeNull();
    } finally {
      await state.delete("junior:cache_warming:gaps:user:1:none");
    }
  });

  it("schedules the horizon when the warmup send fails", async () => {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
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
      await state.delete("junior:cache_warming:gaps:user:1:none");
    }
  });

  it("warms an idle period whose request holds an image over the snapshot limit, up to the image limit", async () => {
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    mocks.sendCacheWarmup.mockClear();
    // Random bytes do not compress, like a screenshot.
    const randomImage = (bytes = 1024 * 1024) =>
      randomBytes(bytes).toString("base64");
    const imageKeyOf = (imageData: string) =>
      `junior:cache_warming:image:${conversationId}:${createHash("sha256")
        .update(imageData)
        .digest("hex")}`;
    const data = randomImage();
    const imageKey = imageKeyOf(data);
    // With `data`, 33.3 MiB of base64, over the 32 MiB image limit.
    const moreImages = Array.from({ length: 3 }, () =>
      randomImage(8 * 1024 * 1024),
    );
    const imageContext: Context = {
      ...context,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", data, mimeType: "image/png" },
          ],
          timestamp: 1,
        },
      ],
    };
    const requests: Array<Record<string, unknown>> = [];
    mockTitleModel("", {
      onRequest: (request) => requests.push(request),
    });
    try {
      // The Turn sends its request to the model service, like a run does.
      const recorder = createCacheWarmingRecorder(
        conversationId,
        turnOf(true),
        definitionsKey,
      );
      await (await recorder.wrap()(model, imageContext, {})).result();
      await recorder.record(finalReply);
      const warmup = scheduledWarmup();
      await runCacheWarmup(warmup);

      // The warmup sends the cached prefix of the Turn's request unchanged.
      expect(requests).toHaveLength(2);
      const [turnRequest, warmupRequest] = requests;
      expect(JSON.stringify(warmupRequest!["messages"])).toContain(data);
      for (const field of ["system", "messages", "tools"]) {
        expect(JSON.stringify(warmupRequest![field])).toBe(
          JSON.stringify(turnRequest![field]),
        );
      }

      // The next idle period lost its image, so its warmup sends nothing.
      await endTurn(true, conversationId, imageContext);
      const next = scheduledWarmup();
      await state.delete(imageKey);
      await runCacheWarmup(next);
      expect(requests).toHaveLength(2);
      expect(
        await state.get(
          `junior:cache_warming:snapshot:${conversationId}:${next.generation}`,
        ),
      ).toBeNull();

      // Images over their limit store nothing, so the idle period gets no
      // warmup.
      mocks.sendCacheWarmup.mockClear();
      await endTurn(true, conversationId, {
        ...imageContext,
        messages: [
          ...imageContext.messages,
          {
            role: "user",
            content: moreImages.map((imageData) => ({
              type: "image" as const,
              data: imageData,
              mimeType: "image/png",
            })),
            timestamp: 2,
          },
        ],
      });
      expect(mocks.sendCacheWarmup).not.toHaveBeenCalled();
      for (const imageData of [data, ...moreImages]) {
        expect(await state.get(imageKeyOf(imageData))).toBeNull();
      }
    } finally {
      for (const imageData of [data, ...moreImages]) {
        await state.delete(imageKeyOf(imageData));
      }
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
    }
  });

  it("counts the savings of each idle period that a call ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A day of its own, so the idle periods of the other cases do not count.
    vi.setSystemTime(new Date("2031-03-01T12:00:00.000Z"));
    const state = getStateAdapter();
    for (let i = 0; i < 20; i++) {
      await state.appendToList(
        "junior:cache_warming:gaps:user:1:none",
        8 * MINUTE,
      );
    }
    mockTitleModel("", { cacheReadTokens: 60_000 });
    const minutesLater = (minutes: number) =>
      vi.setSystemTime(Date.now() + minutes * MINUTE);
    const endTurnWith = async (cacheRead: number, turnContext = context) => {
      const recorder = createCacheWarmingRecorder(
        conversationId,
        turnOf(true),
        definitionsKey,
      );
      void recorder.wrap((() => undefined) as never)(model, turnContext, {});
      await recorder.record({
        ...finalReply,
        usage: {
          ...finalReply.usage,
          cacheRead,
          cacheWrite: 60_000 - cacheRead,
        },
      });
    };
    try {
      const startedAtMs = Date.now();
      await endTurnWith(60_000);
      const warmup = scheduledWarmup();
      vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
      await runCacheWarmup(warmup);
      // The warmed cache still holds the prefix when the person returns.
      vi.setSystemTime(startedAtMs + 7 * MINUTE);
      await endTurnWith(60_000);
      // No warmup ran, so the cache expired before the next return.
      minutesLater(7);
      await endTurnWith(0);
      // The cache lives through a return within its TTL without warmups.
      minutesLater(4);
      // Random text does not compress, so its snapshot is too large to store.
      await endTurnWith(60_000, {
        ...context,
        messages: [
          {
            role: "user",
            content: randomBytes(2 * 1024 * 1024).toString("base64"),
            timestamp: 1,
          },
        ],
      });
      minutesLater(7);
      await endTurnWith(0);

      const response = await createJuniorApi().request(
        "http://localhost/api/cache-warming/savings?days=1",
      );
      const { totals } = cacheWarmingSavingsReportSchema.parse(
        await response.json(),
      );
      // Prices are per million tokens. Each counted gap needs one warmup,
      // which the oracle prices at 1.1 reads.
      const read = (60_000 * model.cost.cacheRead) / 1_000_000;
      const write = (60_000 * model.cost.cacheWrite) / 1_000_000;
      const close = (usd: number) => expect.closeTo(usd, 3);
      expect(totals).toMatchObject({
        idlePeriods: 3,
        hits: 1,
        savedUsd: close(write - read),
        warmupCostUsd: close(read),
        oracleSavingsUsd: close(3 * (write - 2.1 * read)),
        unwarmedIdlePeriods: 1,
        unwarmedOracleSavingsUsd: close(write - 2.1 * read),
      });
    } finally {
      await state.delete("junior:cache_warming:gaps:user:1:none");
      await state.delete("junior:cache_warming:breaker:anthropic:outcomes");
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
      const recorder = createCacheWarmingRecorder(
        conversationId,
        turnOf(true),
        definitionsKey,
      );
      void recorder.wrap(base as never)(
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
