import { afterEach, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createAgentInvocationForMessage } from "@/chat/agent-invocations/create";
import { enqueueAgentInvocation } from "@/chat/agent-invocations/work";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { stopConversation } from "@/chat/conversations/stop";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { enqueueEventNotification } from "@/chat/events/notification";
import { createWatch, takeDueTimerWatches } from "@/chat/events/store";
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
  stoppedConversationMessageTexts,
} from "../fixtures/conversation";
import { context, execute } from "../fixtures/event-automations";
import { spawnChildAgent } from "../fixtures/agent-invocations";

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

it("saves timers of a stopped root to its transcript until a person writes", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const fixture = await timerConversation();
  const { conversationId, tools, queue, drain, agentRuns } = fixture;
  const input = { after_ms: 60_000, intent: "Check the deployment." };
  await execute(tools.watchTimer!, input, "timer-1");
  await execute(
    tools.watchTimer!,
    { after_ms: 600_000, intent: "Check much later." },
    "timer-2",
  );
  await execute(
    tools.watchTimer!,
    { after_ms: 3_600_000, intent: "Check after the reply." },
    "timer-3",
  );
  clock.mockReturnValue(clock() + 60_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  expect(
    (await getConversationWorkState({ conversationId }))?.execution
      .pendingMessages,
  ).toHaveLength(1);

  // While the root is stopped, an event that already arrived, a later one,
  // and one of a watch set after the stop are saved to the transcript and
  // start no Turn. The watches stay as they are.
  await stopConversation({ conversationId, queue });
  await expect(getConversationStoppedAtMs(conversationId)).resolves.toBe(
    clock(),
  );
  clock.mockReturnValue(clock() + 600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  await execute(
    tools.watchTimer!,
    { after_ms: 60_000, intent: "Check after the stop." },
    "timer-4",
  );
  clock.mockReturnValue(clock() + 60_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(0);
  const saved = (await stoppedConversationMessageTexts(conversationId)).join(
    "\n",
  );
  expect(saved).toContain("Check the deployment.");
  expect(saved).toContain("Check much later.");
  expect(saved).toContain("Check after the stop.");
  await expect(fixture.status(conversationId)).resolves.toBe("stopped");

  // A person's message ends the stop, so the next timer starts a Turn.
  await fixture.continue({
    conversationId,
    idempotencyKey: "after-stop",
    message: "Keep watching.",
  });
  await expect(fixture.status(conversationId)).resolves.toBe("active");
  await drain();
  expect(agentRuns).toHaveLength(1);
  await expect(fixture.status(conversationId)).resolves.toBe("completed");
  await expect(
    getConversationStoppedAtMs(conversationId),
  ).resolves.toBeUndefined();
  clock.mockReturnValue(clock() + 3_600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(2);
  expect(agentRuns[1]!.source).toMatchObject({ kind: "event" });
});

it("keeps a root stopped when the stop drops queued input", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const fixture = await timerConversation();
  const { conversationId, tools, queue, drain, agentRuns } = fixture;
  await execute(
    tools.watchTimer!,
    { after_ms: 600_000, intent: "Check the deployment." },
    "timer-1",
  );
  await execute(
    tools.watchTimer!,
    { after_ms: 1_200_000, intent: "Check again later." },
    "timer-2",
  );
  const deployWatch = () =>
    createWatch({
      conversationId,
      events: ["deployment.succeeded"],
      expiresAtMs: clock() + 3_600_000,
      identifier: "prj_junior:production",
      intent: "Report deploy results.",
      label: "Vercel deployment junior-prod",
      namespace: "vercel",
      resourceType: "deployment",
    });
  await deployWatch();

  // The stop drops a person's message that is still queued. That message
  // does not end the stop.
  await fixture.continue({
    conversationId,
    idempotencyKey: "before-stop",
    message: "Are you there?",
  });
  clock.mockReturnValue(clock() + 1_000);
  await expect(
    stopConversation({ conversationId, queue }),
  ).resolves.toMatchObject({ status: "requested" });
  await drain();
  expect(agentRuns).toHaveLength(0);
  clock.mockReturnValue(clock() + 600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(0);
  expect(await stoppedConversationMessageTexts(conversationId)).toEqual([
    expect.stringContaining("Check the deployment."),
  ]);

  // A watch re-created on the same resource after the stop is saved too,
  // in one batch with the next timer.
  const recreated = await deployWatch();
  await enqueueEventNotification({
    event: {
      eventKey: "vercel:deploy-1:deployment.succeeded",
      eventType: "deployment.succeeded",
      identifier: recreated.identifier,
      namespace: recreated.namespace,
      occurredAtMs: clock(),
      trustedSummary: "Deploy succeeded.",
    },
    queue,
    subscription: recreated,
  });
  clock.mockReturnValue(clock() + 500_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(0);
  const saved = await stoppedConversationMessageTexts(conversationId);
  expect(saved).toEqual([
    expect.stringContaining("Check the deployment."),
    expect.stringContaining("Check again later."),
  ]);
  expect(saved[1]).toContain("Deploy succeeded.");
});

it("saves a stopped child's timers until a person writes to its root", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  // The root needs a Destination for its child, so start it with a message.
  const fixture = await timerConversation();
  const { agentRuns, conversationStore, drain, queue, state } = fixture;
  const { conversationId } = await fixture.start({
    idempotencyKey: "root-with-child",
    message: "Start a child.",
  });
  await drain();
  const child = await spawnChildAgent({
    conversationStore,
    idempotencyKey: "child-with-timers",
    parentConversationId: conversationId,
    queue,
    state,
  });
  const childTools = createEventTools(
    { ...context(), conversationId: child.childConversationId },
    getEventCatalog(),
  );
  await execute(
    childTools.watchTimer!,
    { after_ms: 60_000, intent: "Check soon." },
    "child-timer-1",
  );
  await execute(
    childTools.watchTimer!,
    { after_ms: 600_000, intent: "Check later." },
    "child-timer-2",
  );
  await execute(
    childTools.watchTimer!,
    { after_ms: 3_600_000, intent: "Check much later." },
    "child-timer-3",
  );

  // A person's stop of the root also stops the child, so its timer is
  // saved to its transcript and starts no Turn.
  clock.mockReturnValue(clock() + 1_000);
  await stopConversation({ conversationId, queue });
  await drain();
  await expect(
    getConversationStoppedAtMs(child.childConversationId),
  ).resolves.toBe(clock());
  clock.mockReturnValue(clock() + 120_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(agentRuns).toHaveLength(1);
  expect(
    await stoppedConversationMessageTexts(child.childConversationId),
  ).toEqual([expect.stringContaining("Check soon.")]);

  // A person's message to the root ends the stop of the child too, so its
  // next timer starts the child.
  clock.mockReturnValue(clock() + 1_000);
  await fixture.continue({
    conversationId,
    idempotencyKey: "after-root-stop",
    message: "Keep going.",
  });
  await drain();
  await expect(
    getConversationStoppedAtMs(child.childConversationId),
  ).resolves.toBeUndefined();
  clock.mockReturnValue(clock() + 600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(
    agentRuns
      .filter((run) => run.conversationId === child.childConversationId)
      .map((run) => run.source.kind),
  ).toEqual(["event"]);

  // A person's stop of only the child stays in effect when a person writes
  // to the root, because the root itself was not stopped.
  await stopConversation({ conversationId: child.childConversationId, queue });
  await drain();
  clock.mockReturnValue(clock() + 1_000);
  await fixture.continue({
    conversationId,
    idempotencyKey: "after-child-stop",
    message: "Carry on.",
  });
  await drain();
  await expect(
    getConversationStoppedAtMs(child.childConversationId),
  ).resolves.toBeDefined();
  clock.mockReturnValue(clock() + 3_600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(
    agentRuns.filter((run) => run.conversationId === child.childConversationId),
  ).toHaveLength(1);
  expect(
    await stoppedConversationMessageTexts(child.childConversationId),
  ).toEqual([
    expect.stringContaining("Check soon."),
    expect.stringContaining("Check much later."),
  ]);

  // New work from its parent ends the stop of the child, so its next timer
  // starts it.
  await execute(
    childTools.watchTimer!,
    { after_ms: 600_000, intent: "Check after the parent's message." },
    "child-timer-4",
  );
  clock.mockReturnValue(clock() + 1_000);
  const message = await createAgentInvocationForMessage({
    actor: child.actor,
    childConversationId: child.childConversationId,
    destination: child.destination,
    idempotencyKey: "parent-message",
    input: "Keep watching.",
    parentConversationId: conversationId,
    parentToolCallId: "parent-message",
  });
  await enqueueAgentInvocation(message.invocation, {
    conversationStore,
    queue,
    state,
  });
  await drain();
  await expect(
    getConversationStoppedAtMs(child.childConversationId),
  ).resolves.toBeUndefined();
  clock.mockReturnValue(clock() + 600_000);
  await runTimerWatchHeartbeat({ nowMs: clock(), queue });
  clock.mockReturnValue(clock() + 120_000);
  await drain();
  expect(
    agentRuns
      .filter((run) => run.conversationId === child.childConversationId)
      .slice(1)
      .map((run) => run.source.kind),
  ).toEqual(["agent_invocation", "event"]);
});
