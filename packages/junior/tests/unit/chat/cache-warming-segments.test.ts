import { createHash, randomBytes } from "node:crypto";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai/compat";
import type { CacheWarmupMessage } from "@/chat/cache-warming/queue";
import { setConversationArchive } from "@/api/conversations/archive";
import { createAgentInvocation } from "@/chat/agent-invocations/create";
import {
  IDLE_HORIZON_MS,
  NO_REPLY_GAP_MS,
  WARMUP_MARGIN_MS,
} from "@/chat/cache-warming/model";
import { getConversationStore } from "@/chat/db";
import {
  cancelWatch,
  createTimerWatch,
  createWatch,
} from "@/chat/events/store";
import { createApp } from "@/app";
import { defineJuniorPlugins } from "@/plugins";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PromptMode } from "@/chat/system-prompt-rules";
import { getStateAdapter } from "@/chat/state/adapter";
import { mockTitleModel } from "../../fixtures/title-model";

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
// Only this Conversation has plugin work, so the other cases keep `none`.
const workConversationId = "local:test:cache-warming-segments-work";
const childConversationId = `${workConversationId}:child`;
const openWorkConversationId = "local:test:cache-warming-segments-open";
// Only these Conversations have a timer or a child agent.
const timerConversationId = "local:test:cache-warming-segments-timer";
const parentConversationId = "local:test:cache-warming-segments-parent";
// Only this Conversation has an Automation run's Watch.
const automationConversationId = "local:test:cache-warming-segments-automation";
const model = resolveGatewayModel("anthropic/claude-opus-5.5");
const context: Context = {
  systemPrompt: "Answer the person.",
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

const definitionsKey = { platform: "local", mode: "conversation" } as const;

// Run one Turn that ends with a final response, like one agent run does.
async function endTurn(
  userActor: boolean,
  id = conversationId,
  turnContext = context,
  mode: PromptMode = definitionsKey.mode,
) {
  const recorder = createCacheWarmingRecorder(id, userActor, {
    ...definitionsKey,
    mode,
  });
  void recorder.wrap((() => undefined) as never)(model, turnContext, {});
  await recorder.record(finalReply);
}

const toolCall = (name: string): AssistantMessage => ({
  ...finalReply,
  content: [{ type: "toolCall", id: name, name, arguments: {} }],
  stopReason: "toolUse",
});

// Run one Turn that calls a tool and then an answer tool that ends the run,
// like one agent run does.
async function endTurnWithAnswerTool(toolName: string, mode: PromptMode) {
  const recorder = createCacheWarmingRecorder(conversationId, false, {
    ...definitionsKey,
    mode,
  });
  const stream = recorder.wrap((() => undefined) as never);
  void stream(model, context, {});
  await recorder.record(toolCall("systemTime"));
  recorder.toolsReturned();
  vi.advanceTimersByTime(MINUTE);
  void stream(model, context, {});
  await recorder.record(toolCall(toolName));
  recorder.answerToolEnded(toolName);
  await recorder.stop();
}

// Start a child agent that still runs when the parent's Turn ends.
async function startChildAgent() {
  const parentDestination = {
    platform: "local",
    conversationId: parentConversationId,
  } as const;
  await getConversationStore().recordActivity({
    conversationId: parentConversationId,
    destination: parentDestination,
    source: "internal",
  });
  await createAgentInvocation({
    actor: { name: "parent-agent", platform: "system" },
    destination: parentDestination,
    idempotencyKey: "cache-warming-child",
    input: "Summarize the durable task.",
    parentConversationId,
    reasoningLevel: "medium",
  });
}

function scheduledHorizon(): CacheWarmupMessage {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent) => sent.kind === "horizon");
  if (!message) throw new Error("No horizon message was scheduled.");
  return message;
}

type WarmupMessage = Extract<CacheWarmupMessage, { kind: "warmup" }>;

function scheduledWarmup(): WarmupMessage {
  const message = mocks.sendCacheWarmup.mock.calls
    .map(([sent]) => sent as CacheWarmupMessage)
    .reverse()
    .find((sent): sent is WarmupMessage => sent.kind === "warmup");
  if (!message) throw new Error("No warmup was scheduled.");
  return message;
}

const segmentGaps = (segment: string) =>
  getStateAdapter().getList<number>(`junior:cache_warming:gaps:${segment}`);

// Deliver each warmup of the idle period when the queue would, and the
// horizon before the first warmup after it. Return the idle time of each
// warmup that refreshed the cache.
async function runIdleWarmups(sinceMs: number): Promise<number[]> {
  const refreshedAtIdleMs: number[] = [];
  let horizonRan = false;
  for (let warmup = scheduledWarmup(); ; ) {
    vi.setSystemTime(warmup.cacheExpiresAtMs - WARMUP_MARGIN_MS);
    if (!horizonRan && Date.now() - sinceMs >= IDLE_HORIZON_MS) {
      await runCacheWarmup(scheduledHorizon());
      horizonRan = true;
    }
    await runCacheWarmup(warmup);
    const next = scheduledWarmup();
    if (next === warmup) return refreshedAtIdleMs;
    refreshedAtIdleMs.push(Date.now() - sinceMs);
    warmup = next;
  }
}

describe("cache warming gap segments", () => {
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const id of [
      conversationId,
      workConversationId,
      childConversationId,
      openWorkConversationId,
      timerConversationId,
      parentConversationId,
      automationConversationId,
    ]) {
      await getStateAdapter().delete(`junior:cache_warming:conversation:${id}`);
    }
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
      const clearGaps = async () => {
        await getStateAdapter().delete(
          "junior:cache_warming:gaps:system:1:none",
        );
        await getStateAdapter().delete(
          `junior:cache_warming:gaps:conversation:${conversationId}:system:1:none`,
        );
      };
      await clearGaps();
      try {
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
      } finally {
        await clearGaps();
      }
    },
  );

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

  it("records the gap of an idle period that waits on a child agent or a Review item in the segment's child", async () => {
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

      // Another Turn asked a Review item.
      await endTurn(true, conversationId, {
        ...context,
        messages: [...context.messages, toolCall("addReviewItem")],
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
        true,
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
        true,
        definitionsKey,
      );
      await (await recorder.wrap()(model, imageContext, {})).result();
      await recorder.record(finalReply);
      const warmup = scheduledWarmup();
      await runCacheWarmup(warmup);

      // The warmup sends the cached prefix of the Turn's request unchanged.
      expect(requests).toHaveLength(2);
      const [turnRequest, warmupRequest] = requests;
      expect(JSON.stringify(warmupRequest!.messages)).toContain(data);
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
        true,
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
