import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryRetryableError } from "@/delivery/deliver";
import { publishTurnEnded } from "@/core/turn/ended";
import type { EngineContext } from "@/core/engine-context";
import {
  createTurn,
  findDiscardedUsage,
  TURN_PRIORITY,
} from "@/core/turn/state";
import { TURN_ENDED_TOPIC, TURN_STEP_TOPIC } from "@/core/turn/topic";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { juniorConversationBindings, juniorTurnOutbox } from "@/db/schema";
import { compat__personMessageId } from "@/turn-steps/compat__message-id";
import { turnEndedConsumer } from "@/turn-steps/turn-ended";
import {
  modelCalls,
  modelRejected,
  setModelReplies,
} from "../fixtures/ai-emulator";
import type { InProcessQueue } from "../fixtures/in-process-queue";
import { createAssistantMessage } from "../fixtures/model-stream";
import { createRecordingDelivery } from "../fixtures/recording-delivery";
import {
  CONVERSATION_ID,
  messageTurnId,
  stepWith,
  startTurnEngine,
  storedReply,
  type TurnEngine,
  userText,
} from "../fixtures/turn-engine";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";

// Delivery of core Turn replies to their Destination: core sends a Turn-ended
// message, and the host's consumer sends the Turn's replies with a recording
// Delivery. The test delivers the messages from the in-process queue.

// Longer than the longest delivery backoff, so every delayed check is due.
const AFTER_EVERY_BACKOFF_SECONDS = 60;

function reply(text: string) {
  return createAssistantMessage({ type: "text", text });
}

/** Counts the Turn-ended messages of a Turn that the consumer finished. */
function handledDeliveries(queue: InProcessQueue, turnId: string) {
  return queue
    .delivered(TURN_ENDED_TOPIC)
    .filter((message) => messageTurnId(message.payload) === turnId).length;
}

function readOutbox(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
) {
  return executor
    .db()
    .select()
    .from(juniorTurnOutbox)
    .where(eq(juniorTurnOutbox.conversationId, conversationId))
    .orderBy(juniorTurnOutbox.eventSeq);
}

async function allSent(
  engineCtx: Pick<EngineContext, "executor">,
  conversationId: string,
) {
  const rows = await readOutbox(engineCtx, conversationId);
  return rows.length > 0 && rows.every((row) => row.state === "sent");
}

/**
 * Holds the Conversation's delivery lock, as a delivery that is still
 * sending does, until the returned function is called.
 */
async function holdDeliveryLock(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = executor.withLock(
    `junior:delivery:${conversationId}`,
    async () => {
      held();
      await released;
    },
  );
  await lockHeld;
  return async () => {
    release();
    await holder;
  };
}

/**
 * Compat: the reply messages and Turn end events that the host writes
 * for main's readers, in event order. The person's messages are left out.
 */
async function compatReplyEvents(harness: TurnHarness) {
  return (await harness.events())
    .map((event) => event.data)
    .filter(
      (data) =>
        (data.type === "message" && data.role === "assistant") ||
        (data.type === "message_handled" &&
          data.messageId.includes(":assistant:")) ||
        data.type === "turn_completed" ||
        data.type === "turn_failed",
    );
}

afterEach(() => {
  vi.restoreAllMocks();
});

// The real path: an input goes through scheduleInput, the host's Turn step
// consumer runs the Turn, and the host's delivery consumer posts its reply.
describe("Turn delivery", () => {
  let harness: TurnHarness;

  beforeEach(async () => {
    harness = await createTurnHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Runs the queue after every delivery backoff has passed. */
  function runAfterBackoff() {
    harness.queue.advanceTime(AFTER_EVERY_BACKOFF_SECONDS);
    return harness.runUntilIdle();
  }

  /** Sends one input whose Turn replies `text`. */
  async function sendForReply(text: string) {
    await setModelReplies([reply(text)]);
    return harness.send({ text: "How many Turns?" });
  }

  it("checks back when another delivery holds the Conversation, and posts the reply once", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    const release = await holdDeliveryLock(engineCtx, conversationId);

    const { turnId } = await sendForReply("Three.");
    await harness.runUntilIdle();
    expect(handledDeliveries(queue, turnId)).toBe(1);

    expect(harness.sends()).toEqual([]);
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    await release();
    await runAfterBackoff();
    await expect(allSent(engineCtx, conversationId)).resolves.toBe(true);
    expect(handledDeliveries(queue, turnId)).toBe(2);
    expect(harness.sends()).toEqual([{ text: "Three.", destination }]);
  });

  it("retries a reply after a retryable failure, then sends it", async () => {
    const { engineCtx, conversationId, destination } = harness;
    harness.failNextSend(new DeliveryRetryableError("Slack is unavailable"));

    const { turnId, inputId } = await sendForReply("Three.");
    // The person's visible message, as main's readers need it before the
    // reply marks it handled. Nothing on this path writes it yet.
    const inputMessageId = compat__personMessageId(inputId);
    await createSqlConversationEventStore(engineCtx.executor).append(
      conversationId,
      [
        {
          idempotencyKey: `message:${inputMessageId}`,
          createdAtMs: Date.now(),
          data: {
            type: "message",
            messageId: inputMessageId,
            role: "user",
            text: "How many Turns?",
          },
        },
      ],
    );
    await harness.runUntilIdle();
    // Compat: the Turn has a pending reply, so it has no end yet.
    await expect(compatReplyEvents(harness)).resolves.toEqual([]);
    await runAfterBackoff();

    // Compat: one reply message, its handled marks, then the end.
    const assistantMessageId = expect.stringMatching(
      new RegExp(`^${turnId}:assistant:`),
    );
    const ended = [
      {
        type: "message",
        messageId: assistantMessageId,
        role: "assistant",
        text: "Three.",
        meta: expect.objectContaining({
          source: "slack",
          slackTs: "message-2",
        }),
      },
      { type: "message_handled", messageId: assistantMessageId },
      { type: "turn_completed", turnId, outcome: "success" },
    ];
    await expect(compatReplyEvents(harness)).resolves.toEqual(ended);
    // The reply marks the person's message handled before the Turn ends.
    const order = (await harness.events()).flatMap(({ data }) =>
      data.type === "message_handled" && data.messageId === inputMessageId
        ? ["input handled"]
        : data.type === "turn_completed"
          ? ["ended"]
          : [],
    );
    expect(order).toEqual(["input handled", "ended"]);
    // A Turn-ended message that comes again writes none of them twice.
    await publishTurnEnded(engineCtx, { conversationId, turnId });
    await harness.runUntilIdle();
    await expect(compatReplyEvents(harness)).resolves.toEqual(ended);
    await expect(
      engineCtx.executor
        .db()
        .select()
        .from(juniorConversationBindings)
        .where(eq(juniorConversationBindings.conversationId, conversationId)),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: "slack",
        providerConversationId: harness.location.threadTs,
      }),
    ]);

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // The failed try and the try that worked.
    expect(harness.sends()).toEqual([
      { text: "Three.", destination },
      { text: "Three.", destination },
    ]);
  });

  it("waits the Retry-After of a retryable failure before it tries a reply again", async () => {
    const { engineCtx, conversationId, queue } = harness;
    harness.failNextSend(
      new DeliveryRetryableError("Rate limited", { retryAfterMs: 2000 }),
    );

    await sendForReply("Three.");
    await harness.runUntilIdle();

    // The backoff after a first failure is 1 s, so 2 s is the Retry-After.
    expect(queue.pending(TURN_ENDED_TOPIC)).toEqual([
      expect.objectContaining({ delaySeconds: 2, due: false }),
    ]);
    queue.advanceTime(2);
    await harness.runUntilIdle();
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // The rate-limited try, then the try that worked.
    expect(harness.sends()).toHaveLength(2);
  });

  it("waits at most a minute for a long Retry-After, so the sweep never takes a waiting reply", async () => {
    const { queue } = harness;
    harness.failNextSend(
      new DeliveryRetryableError("Rate limited", { retryAfterMs: 600_000 }),
    );

    await sendForReply("Three.");
    await harness.runUntilIdle();

    expect(queue.pending(TURN_ENDED_TOPIC)).toEqual([
      expect.objectContaining({ delaySeconds: 60, due: false }),
    ]);
  });

  it("records no outbox row for an input whose answer is only the history, and writes its reply message at the Turn end", async () => {
    const { engineCtx, conversationId, queue } = harness;
    await setModelReplies([reply("Three.")]);

    const { turnId } = await harness.send({
      text: "How many Turns?",
      source: { kind: "web", visibility: "private", conversationId },
      destination: null,
    });
    await harness.runUntilIdle();
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(handledDeliveries(queue, turnId)).toBe(1);

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([]);
    expect(harness.sends()).toEqual([]);
    // Compat: the reply message, with no delivery, before the end.
    await expect(compatReplyEvents(harness)).resolves.toEqual([
      expect.objectContaining({ role: "assistant", text: "Three." }),
      expect.objectContaining({ type: "message_handled" }),
      { type: "turn_completed", turnId, outcome: "success" },
    ]);
  });

  it("writes main's failed Turn end for a Turn that fails", async () => {
    // Injected fault: the model provider rejects the request.
    await setModelReplies([modelRejected()]);

    const { turnId } = await harness.send({ text: "How many Turns?" });
    await harness.runUntilIdle();

    const turn = await harness.turn(turnId);
    expect(turn.state).toBe("failed");
    // Compat: the failure as the Turn stored it.
    await expect(compatReplyEvents(harness)).resolves.toEqual([
      {
        type: "turn_failed",
        turnId,
        failureCode: "model_execution_failed",
        failureReason: "invalid_request",
        eventId: turn.failureEventId,
      },
    ]);
  });

  it("sends to the input's Destination, not the Conversation's Location", async () => {
    const { conversationId, location } = harness;
    const threadTs = "1718123999.000000";
    await setModelReplies([reply("Three.")]);

    await harness.send({
      text: "How many Turns?",
      destination: {
        platform: "slack",
        teamId: location.teamId,
        channelId: location.channelId,
        threadTs,
      },
    });
    await harness.runUntilIdle();

    expect(harness.sends().map((send) => send.destination)).toEqual([
      expect.objectContaining({ threadTs }),
    ]);
    await expect(
      readOutbox(harness.engineCtx, conversationId),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "sent",
        destination: expect.objectContaining({ threadTs }),
      }),
    ]);
  });

  it("keeps a Destination it does not know, as the Source wrote it", async () => {
    const { engineCtx, conversationId } = harness;
    const destination = { platform: "carrier-pigeon", coop: 3 };
    await setModelReplies([reply("Three.")]);

    const { turnId } = await harness.send({
      text: "How many Turns?",
      destination,
    });
    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ destination }),
    ]);
  });

  it("fails a reply whose Destination is not valid, without sending it", async () => {
    const { engineCtx, conversationId, location } = harness;
    await setModelReplies([reply("Three.")]);

    const { turnId } = await harness.send({
      text: "How many Turns?",
      destination: { platform: "slack", teamId: location.teamId },
    });
    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        attempts: 0,
        error: "The Destination is not valid",
      }),
    ]);
    expect(harness.sends()).toEqual([]);
  });

  it("fails a reply whose send throws an error that is not retryable", async () => {
    const { engineCtx, conversationId } = harness;
    harness.failNextSend(new Error("channel_not_found"));

    await sendForReply("Three.");
    await harness.runUntilIdle();
    await runAfterBackoff();

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        attempts: 1,
        error: "channel_not_found",
      }),
    ]);
    expect(harness.sends()).toHaveLength(1);
    // Compat: the Turn still ends, with no reply message.
    await expect(compatReplyEvents(harness)).resolves.toEqual([
      expect.objectContaining({ type: "turn_completed", outcome: "success" }),
    ]);
  });

  it("posts the reply on a redelivered step message after a crash before the Turn-ended message", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    const { turnId } = await sendForReply("Three.");
    // Stands in for the process dying after the end commit, before the
    // Turn-ended message is sent.
    vi.spyOn(queue, "send").mockRejectedValueOnce(
      new Error("The queue is unreachable"),
    );

    await harness.runStep();
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    // The step message failed, so the queue keeps it for a redelivery.
    expect(queue.pending(TURN_STEP_TOPIC)).toEqual([
      expect.objectContaining({ deliveryCount: 1 }),
    ]);

    // The queue delivers the same step message again. Its claim misses.
    await harness.runUntilIdle();
    await expect(allSent(engineCtx, conversationId)).resolves.toBe(true);

    expect(harness.sends()).toEqual([{ text: "Three.", destination }]);
  });

  it("keeps a reply's outbox row when the queue drops its Turn-ended message, and the next one sends it", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    const { turnId } = await sendForReply("Three.");
    const send = queue.send.bind(queue);
    // Injected fault: the queue takes the Turn-ended message and loses it.
    vi.spyOn(queue, "send").mockImplementation((topic, payload, options) =>
      topic === TURN_ENDED_TOPIC
        ? Promise.resolve({})
        : send(topic, payload, options),
    );

    await harness.runUntilIdle();
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(harness.sends()).toEqual([]);
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ turnId, state: "pending" }),
    ]);

    vi.mocked(queue.send).mockRestore();
    await publishTurnEnded(engineCtx, { conversationId, turnId });
    await harness.runUntilIdle();

    expect(harness.sends()).toEqual([{ text: "Three.", destination }]);
  });
  /**
   * Runs `during` once, while the next model request is in flight, as an
   * input that arrives mid-reply does.
   */
  function duringNextModelRequest(during: () => Promise<unknown>) {
    const send = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (...args) => {
      await during();
      return send(...args);
    });
  }

  it("answers an input that arrives during the final reply with one new reply, and drops the first", async () => {
    const { engineCtx, destination } = harness;
    const answer = reply("Three, and none failed.");
    await setModelReplies([reply("Three."), answer]);
    const { turnId } = await harness.send({ text: "How many Turns?" });
    duringNextModelRequest(() =>
      harness.send({ text: "And how many failed?" }),
    );

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(harness.sends()).toEqual([
      { text: "Three, and none failed.", destination },
    ]);
    await expect(harness.history()).resolves.toEqual([
      userText("How many Turns?"),
      userText("And how many failed?"),
      storedReply(answer),
    ]);
    // The second request reads both inputs and not the dropped reply.
    const [, redo] = await modelCalls();
    const texts = redo!.messages.flatMap((message) =>
      message.parts.map((part) => part.text),
    );
    expect(texts).toContain("And how many failed?");
    expect(texts).not.toContain("Three.");
    const discarded = await findDiscardedUsage(engineCtx, turnId);
    expect(discarded?.tokens?.outputTokens).toBeGreaterThan(0);
  });

  it("posts the final reply of a Turn that another Turn supersedes while it waits on a newer input", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    await setModelReplies([reply("Three.")]);
    const { turnId } = await harness.send({ text: "How many Turns?" });
    duringNextModelRequest(async () => {
      await harness.send({ text: "And how many failed?" });
      await createTurn(engineCtx, {
        conversationId,
        priority: TURN_PRIORITY.supersede,
      });
    });

    await harness.runStep();
    await queue.runUntilIdle(TURN_ENDED_TOPIC);

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "cancelled",
      endReason: "superseded",
    });
    expect(harness.sends()).toEqual([{ text: "Three.", destination }]);
  });

  it("fails a reply after its fifth retryable failure, then posts the next Turn's reply", async () => {
    const { engineCtx, conversationId, destination } = harness;
    const release = await holdDeliveryLock(engineCtx, conversationId);
    await sendForReply("Three.");
    await harness.runUntilIdle();
    await sendForReply("None.");
    await harness.runUntilIdle();
    const [head] = await readOutbox(engineCtx, conversationId);
    // Four retryable failures so far, so the next one is the fifth.
    await engineCtx.executor
      .db()
      .update(juniorTurnOutbox)
      .set({ attempts: 4 })
      .where(eq(juniorTurnOutbox.id, head!.id));
    harness.failNextSend(new DeliveryRetryableError("Slack is unavailable"));

    await release();
    await runAfterBackoff();

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        attempts: 5,
        error: expect.any(String),
        sentAt: null,
      }),
      expect.objectContaining({ state: "sent", attempts: 0 }),
    ]);
    expect(harness.sends()).toEqual([
      { text: "Three.", destination },
      { text: "None.", destination },
    ]);
  });
});

// These cases need a fault or a timing that no edge can give: an input that
// arrives while the model request runs, which makes a Turn with two replies.
describe("Turn delivery with a test step", () => {
  const THREAD_TS = "1718123456.000000";
  const DESTINATION = {
    platform: "slack",
    teamId: "T123",
    channelId: "C123",
    threadTs: THREAD_TS,
  } as const;

  let engine: TurnEngine;
  let turnId: string;
  let recording: ReturnType<typeof createRecordingDelivery>;

  beforeEach(async () => {
    engine = await startTurnEngine();
    ({ turnId } = engine);
    recording = createRecordingDelivery();
    engine.queue.mount(
      TURN_ENDED_TOPIC,
      turnEndedConsumer(engine.engineCtx, recording.delivery),
    );
  });

  afterEach(async () => {
    await engine.close();
  });

  /** Delivers each delivery message that is due, and returns how many. */
  function deliver() {
    return engine.queue.runUntilIdle(TURN_ENDED_TOPIC);
  }

  /** Runs a step whose reply `text` misses an input that arrives during it. */
  function advanceStaleStep(text: string) {
    const step = stepWith([reply(text)]);
    // The reply is dropped, and the Turn runs the step again.
    return engine.advance({
      ...step,
      client: {
        complete: async (request, signal) => {
          await engine.addTestInput("And how many failed?", DESTINATION);
          return step.client.complete(request, signal);
        },
      },
    });
  }

  it("sends nothing while the Turn runs, then its one reply once it ends", async () => {
    await engine.addTestInput("How many Turns?", DESTINATION);
    await advanceStaleStep("Three.");
    // A Turn-ended message that arrives while the Turn runs sends nothing.
    await publishTurnEnded(engine.engineCtx, {
      conversationId: CONVERSATION_ID,
      turnId,
    });
    await deliver();
    expect(recording.sends()).toEqual([]);

    await engine.advance(stepWith([reply("Three, and none failed.")]));
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(recording.sends()).toEqual([
      { text: "Three, and none failed.", destination: DESTINATION },
    ]);
    await expect(
      readOutbox(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        turnId,
        destination: DESTINATION,
        state: "sent",
        attempts: 0,
        providerMessageId: expect.any(String),
      }),
    ]);
  });
});
