import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryRetryableError } from "@/core/delivery/deliver";
import { publishDelivery } from "@/core/delivery/queue";
import { DELIVERY_TOPIC } from "@/core/delivery/topic";
import type { EngineContext } from "@/core/engine-context";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { juniorTurnOutbox } from "@/db/schema";
import { deliveryConsumer } from "@/turn-steps/delivery";
import { modelRejected, setModelReplies } from "../fixtures/ai-emulator";
import type { InProcessQueue } from "../fixtures/in-process-queue";
import { createAssistantMessage } from "../fixtures/model-stream";
import { createRecordingDelivery } from "../fixtures/recording-delivery";
import type { LocalJuniorSqlFixture } from "../fixtures/sql";
import {
  CONVERSATION_ID,
  messageTurnId,
  stepWith,
  startTurnEngine,
  type TurnEngine,
} from "../fixtures/turn-engine";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";

// Delivery of core Turn replies to their Destination: a committed step sends a
// delivery message, and the delivery consumer sends the Turn's replies with a
// recording Delivery. The test delivers the messages from the in-process queue.

// Longer than the longest delivery backoff, so every delayed check is due.
const AFTER_EVERY_BACKOFF_SECONDS = 60;

function reply(text: string) {
  return createAssistantMessage({ type: "text", text });
}

/** Counts the delivery messages of a Turn that the consumer finished. */
function handledDeliveries(queue: InProcessQueue, turnId: string) {
  return queue
    .delivered(DELIVERY_TOPIC)
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

    await sendForReply("Three.");
    await harness.runUntilIdle();
    await runAfterBackoff();

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
    expect(queue.pending(DELIVERY_TOPIC)).toEqual([
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

    expect(queue.pending(DELIVERY_TOPIC)).toEqual([
      expect.objectContaining({ delaySeconds: 60, due: false }),
    ]);
  });

  it("records nothing for an input whose answer is only the history", async () => {
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
  });

  it("posts the reply on a redelivered step message after a crash before the delivery message", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    const { turnId } = await sendForReply("Three.");
    // Stands in for the process dying after the end commit, before the
    // delivery message is sent.
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

  it("keeps a reply's outbox row when the queue drops its delivery message, and the next delivery sends it", async () => {
    const { engineCtx, conversationId, destination, queue } = harness;
    const { turnId } = await sendForReply("Three.");
    const send = queue.send.bind(queue);
    // Injected fault: the queue takes the delivery message and loses it.
    vi.spyOn(queue, "send").mockImplementation((topic, payload, options) =>
      topic === DELIVERY_TOPIC
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
    await publishDelivery(engineCtx, { conversationId, turnId });
    await harness.runUntilIdle();

    expect(harness.sends()).toEqual([{ text: "Three.", destination }]);
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
  let fixture: LocalJuniorSqlFixture;
  let turnId: string;
  let recording: ReturnType<typeof createRecordingDelivery>;

  beforeEach(async () => {
    engine = await startTurnEngine();
    ({ fixture, turnId } = engine);
    recording = createRecordingDelivery();
    engine.queue.mount(
      DELIVERY_TOPIC,
      deliveryConsumer(engine.engineCtx, recording.delivery),
    );
  });

  afterEach(async () => {
    await engine.close();
  });

  /** Delivers each delivery message that is due, and returns how many. */
  function deliver() {
    return engine.queue.runUntilIdle(DELIVERY_TOPIC);
  }

  /** Delivers the delivery messages that wait out a backoff, too. */
  function deliverAfterBackoff() {
    engine.queue.advanceTime(AFTER_EVERY_BACKOFF_SECONDS);
    return deliver();
  }

  /** Runs a step that replies `text` and commits "continue". */
  function advanceContinuingStep(text: string) {
    const step = stepWith([reply(text)]);
    // An input during the step continues the Turn, so it gets a next step.
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

  /** Runs a Turn whose two steps reply `first`, then `second`. */
  async function advanceTwoReplies(first: string, second: string) {
    await engine.addTestInput("How many Turns?", DESTINATION);
    await advanceContinuingStep(first);
    await engine.advance(stepWith([reply(second)]));
  }

  it("sends the replies of one Turn to its Destination in order", async () => {
    await advanceTwoReplies("Three.", "None.");

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(handledDeliveries(engine.queue, turnId)).toBe(2);
    await expect(allSent(engine.engineCtx, CONVERSATION_ID)).resolves.toBe(
      true,
    );
    expect(recording.sends()).toEqual([
      { text: "Three.", destination: DESTINATION },
      { text: "None.", destination: DESTINATION },
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
      expect.objectContaining({ turnId, state: "sent" }),
    ]);
  });

  it("fails a reply after its fifth retryable failure, then posts the next reply", async () => {
    const release = await holdDeliveryLock(engine.engineCtx, CONVERSATION_ID);
    await advanceTwoReplies("Three.", "None.");
    await deliver();
    expect(handledDeliveries(engine.queue, turnId)).toBe(2);
    const [head] = await readOutbox(engine.engineCtx, CONVERSATION_ID);
    // Four retryable failures so far, so the next one is the fifth.
    await fixture.sql
      .db()
      .update(juniorTurnOutbox)
      .set({ attempts: 4 })
      .where(eq(juniorTurnOutbox.id, head!.id));
    recording.failNext(new DeliveryRetryableError("Slack is unavailable"));

    await release();
    await deliverAfterBackoff();

    await expect(
      readOutbox(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        state: "failed",
        attempts: 5,
        error: expect.any(String),
        sentAt: null,
      }),
      expect.objectContaining({ state: "sent", attempts: 0 }),
    ]);
    expect(recording.sends()).toEqual([
      { text: "Three.", destination: DESTINATION },
      { text: "None.", destination: DESTINATION },
    ]);
  });

  it("posts a Turn's earlier reply when its delivery message was lost and a later step fails", async () => {
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after a "continue" commit, before the
    // delivery message is sent.
    vi.spyOn(engine.queue, "send").mockRejectedValueOnce(failure);
    await engine.addTestInput("How many Turns?", DESTINATION);
    await expect(advanceContinuingStep("Three.")).rejects.toBe(failure);

    // The queue delivers the same step message again. It claims the queued
    // Turn, and the next step fails.
    // Injected fault: the model provider rejects the request.
    await engine.advance(stepWith([modelRejected()]));
    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    await deliver();
    await expect(allSent(engine.engineCtx, CONVERSATION_ID)).resolves.toBe(
      true,
    );

    expect(recording.sends()).toEqual([
      { text: "Three.", destination: DESTINATION },
    ]);
  });
});
