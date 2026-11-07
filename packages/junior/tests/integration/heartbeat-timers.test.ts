import { afterEach, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { stopConversationSession } from "@/chat/agent-invocations/stop";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { takeDueTimerWatches } from "@/chat/events/store";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { createEventTools } from "@/chat/tools/events";
import {
  createConversationId,
  recordWebConversationActivity,
} from "@/chat/conversations/web-input";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  closeConversationFixture,
  createConversationWebHarness,
} from "../fixtures/conversation";
import { context, execute } from "../fixtures/event-automations";

// Timer heartbeat coverage lives here because heartbeat.test.ts is at its file limit.
afterEach(async () => {
  vi.restoreAllMocks();
  await closeConversationFixture();
});

async function timerConversation() {
  const fixture = await createConversationWebHarness();
  const conversationId = createConversationId({
    actorEmail: fixture.actor.email,
    idempotencyKey: crypto.randomUUID(),
  });
  await recordWebConversationActivity({
    actor: fixture.actor,
    conversationId,
    conversationStore: fixture.conversationStore,
    nowMs: Date.now(),
  });
  const tools = createEventTools(
    { ...context(), conversationId },
    getEventCatalog(),
  );
  return { ...fixture, conversationId, tools };
}

it("delivers timers once through heartbeat and keeps existing Watch controls", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { conversationId, tools, queue, drain, historyTexts, agentRuns } =
    await timerConversation();
  const input = { after_ms: 60_000, intent: "Check the deployment." };
  const timer = (await execute(tools.watchTimer!, input, "timer-1")) as {
    id: string;
    fires_at: string;
  };
  const firesAtMs = clock() + 60_000;
  expect(timer).toEqual({
    id: expect.any(String),
    fires_at: new Date(firesAtMs).toISOString(),
  });
  clock.mockReturnValue(clock() + 10_000);
  expect(await execute(tools.watchTimer!, input, "timer-1")).toEqual(timer);
  const cancelled = (await execute(
    tools.watchTimer!,
    input,
    "timer-cancel",
  )) as { id: string };
  await execute(tools.stopWatchingResources!, { id: cancelled.id });
  expect(await execute(tools.listWatches!, {})).toMatchObject({
    subscriptions: [{ id: timer.id, fires_at: timer.fires_at }],
  });
  await runHeartbeat({
    nowMs: firesAtMs - 1,
    conversationWorkQueue: queue,
  });
  expect(queue.sentRecords()).toHaveLength(0);

  clock.mockReturnValue(firesAtMs);
  await runHeartbeat({ nowMs: clock(), conversationWorkQueue: queue });
  expect(queue.sentRecords()).toEqual([
    expect.objectContaining({ conversationId, delayMs: 30_000 }),
  ]);
  const work = await getConversationWorkState({ conversationId });
  expect(work?.execution.pendingMessages).toHaveLength(1);
  expect(work?.execution.pendingMessages[0]).toMatchObject({
    source: "event",
    delivery: "defer",
    input: {
      text: expect.stringContaining(input.intent),
      metadata: { event: { namespace: "junior", eventType: "timer.fired" } },
    },
  });
  expect(await execute(tools.listWatches!, {})).toEqual({ subscriptions: [] });
  await expect(
    execute(tools.stopWatchingResources!, { id: timer.id }),
  ).rejects.toThrow("already completed");

  // A tool replay does not rearm a completed timer; the cancelled one stays quiet.
  clock.mockReturnValue(clock() + 120_000);
  expect(await execute(tools.watchTimer!, input, "timer-1")).toEqual(timer);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);
  expect(await takeDueTimerWatches(clock())).toEqual([]);
  await drain();
  expect(agentRuns).toHaveLength(1);
  // The timer Turn stays system-acted but can use the creator's grants.
  expect(agentRuns[0]!.credentialContext).toEqual({
    actor: { platform: "system", name: "event" },
    subject: expect.objectContaining({
      type: "user",
      userId: "U123",
      allowedWhen: "timer-watch",
      binding: expect.objectContaining({
        conversationId,
        watchId: timer.id,
      }),
    }),
  });
  expect(await historyTexts(conversationId)).toContain(
    "Conversation request complete.",
  );
});

it("recovers an abandoned claim and a failed queue send without duplicating input", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { conversationId, tools, queue } = await timerConversation();
  const timer = (await execute(
    tools.watchTimer!,
    { after_ms: 1, intent: "Check once." },
    "timer-retry",
  )) as { id: string };
  clock.mockReturnValue(clock() + 1);
  expect(await takeDueTimerWatches(clock())).toMatchObject([{ id: timer.id }]);
  // A second heartbeat cannot claim work while its lease is live.
  expect(await takeDueTimerWatches(clock())).toEqual([]);
  clock.mockReturnValue(clock() + 120_000);
  queue.rejectSends();
  await expect(
    runTimerWatchHeartbeat({ nowMs: clock(), queue }),
  ).rejects.toThrow("Timer Watch delivery failed");
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);
  queue.allowSends();
  clock.mockReturnValue(clock() + 120_000);
  await runHeartbeat({ nowMs: clock(), conversationWorkQueue: queue });
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);
  expect(queue.sentRecords()).toHaveLength(1);
  expect(await execute(tools.listWatches!, {})).toEqual({ subscriptions: [] });

  await execute(
    tools.watchTimer!,
    { after_ms: 1, intent: "Do not deliver stale work." },
    "timer-expired",
  );
  clock.mockReturnValue(clock() + 24 * 60 * 60 * 1000 + 2);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  expect(await takeDueTimerWatches(clock())).toEqual([]);
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);
});

it("drops a fired timer when the root session stops, the same as a child", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const { conversationId, tools, queue, drain, agentRuns } =
    await timerConversation();
  const input = { after_ms: 60_000, intent: "Check the deployment." };
  await execute(tools.watchTimer!, input, "timer-1");
  await execute(
    tools.watchTimer!,
    { after_ms: 600_000, intent: "Check much later." },
    "timer-2",
  );
  clock.mockReturnValue(clock() + 60_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);

  // The Slack `stop` keyword runs this session stop on a root.
  await stopConversationSession({ conversationId, queue });
  expect(await execute(tools.listWatches!, {})).toEqual({ subscriptions: [] });
  clock.mockReturnValue(clock() + 600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  await drain();
  expect(agentRuns).toHaveLength(0);

  // A watch set after the stop wakes the root again.
  await execute(tools.watchTimer!, input, "timer-3");
  clock.mockReturnValue(clock() + 60_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(1);
});
