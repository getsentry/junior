import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_TOPIC } from "@/core/delivery/topic";
import type { EngineContext } from "@/core/engine-context";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import {
  juniorConversations,
  juniorTurnInbox,
  juniorTurnOutbox,
  juniorTurns,
} from "@/db/schema";
import { deliveryConsumer } from "@/turn-steps/delivery";
import { modelOverloaded, setModelReplies } from "../fixtures/ai-emulator";
import type { InProcessQueue } from "../fixtures/in-process-queue";
import { createAssistantMessage } from "../fixtures/model-stream";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { FakeSlackAdapter } from "../fixtures/slack-harness";
import {
  buildJuniorSqlConversation,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  CONVERSATION_ID,
  messageTurnId,
  stepWith,
  startTurnEngine,
  type TurnEngine,
} from "../fixtures/turn-engine";
import { createTurnHarness, type TurnHarness } from "../fixtures/turn-harness";
import {
  queueSlackApiError,
  queueSlackRateLimit,
} from "../msw/handlers/slack-api";

// Delivery of core Turn replies to Slack: a committed step sends a delivery
// message, and the app's delivery consumer posts the Turn's replies. The test
// delivers the messages from the in-process queue.

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

function setConversation(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
  values: Partial<typeof juniorConversations.$inferInsert>,
) {
  return executor
    .db()
    .update(juniorConversations)
    .set(values)
    .where(eq(juniorConversations.conversationId, conversationId));
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
    const { engineCtx, conversationId, location, queue } = harness;
    const release = await holdDeliveryLock(engineCtx, conversationId);

    const { turnId } = await sendForReply("Three.");
    await harness.runUntilIdle();
    expect(handledDeliveries(queue, turnId)).toBe(1);

    expect(harness.slackPosts()).toEqual([]);
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    await release();
    await runAfterBackoff();
    await expect(allSent(engineCtx, conversationId)).resolves.toBe(true);
    expect(handledDeliveries(queue, turnId)).toBe(2);
    expect(harness.slackPosts()).toEqual([
      { text: "Three.", thread: location.threadTs },
    ]);
  });

  it("retries a reply after a retryable Slack failure, then posts it", async () => {
    const { engineCtx, conversationId, location } = harness;
    queueSlackApiError("chat.postMessage", { error: "fatal_error" });

    await sendForReply("Three.");
    await harness.runUntilIdle();
    await runAfterBackoff();

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // The failed post and the post that Slack took.
    expect(harness.slackPosts()).toEqual([
      { text: "Three.", thread: location.threadTs },
      { text: "Three.", thread: location.threadTs },
    ]);
  });

  it("waits the Retry-After of a Slack rate limit before it tries a reply again", async () => {
    const { engineCtx, conversationId, queue } = harness;
    // Every try of one post: the Slack client retries a rate limit itself.
    for (let attempt = 0; attempt < 3; attempt++) {
      queueSlackRateLimit("chat.postMessage", 2);
    }

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
    // Three rate-limited posts, then the post that Slack took.
    expect(harness.slackPosts()).toHaveLength(4);
  }, 20_000);

  it("records nothing for a Conversation without a Location", async () => {
    const { engineCtx, conversationId, queue } = harness;
    await setConversation(engineCtx, conversationId, { location: null });

    const { turnId } = await sendForReply("Three.");
    await harness.runUntilIdle();
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(handledDeliveries(queue, turnId)).toBe(1);

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([]);
    expect(harness.slackPosts()).toEqual([]);
  });

  it("posts the reply on a redelivered step message after a crash before the delivery message", async () => {
    const { engineCtx, conversationId, location, queue } = harness;
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

    expect(harness.slackPosts()).toEqual([
      { text: "Three.", thread: location.threadTs },
    ]);
  });

  it("posts nothing while the Conversation's Delivery is paused", async () => {
    const { engineCtx, conversationId, queue } = harness;
    await setConversation(engineCtx, conversationId, {
      deliveryPausedAt: new Date(),
    });

    const { turnId } = await sendForReply("Three.");
    await harness.runUntilIdle();
    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(handledDeliveries(queue, turnId)).toBe(1);

    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([]);
    expect(harness.slackPosts()).toEqual([]);
  });

  it("still posts a reply recorded before the Conversation's Delivery was paused", async () => {
    const { engineCtx, conversationId, location, queue } = harness;
    const release = await holdDeliveryLock(engineCtx, conversationId);
    const { turnId } = await sendForReply("Three.");
    await harness.runUntilIdle();
    expect(handledDeliveries(queue, turnId)).toBe(1);
    await expect(readOutbox(engineCtx, conversationId)).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    await setConversation(engineCtx, conversationId, {
      deliveryPausedAt: new Date(),
    });
    await release();
    await runAfterBackoff();
    await expect(allSent(engineCtx, conversationId)).resolves.toBe(true);

    expect(harness.slackPosts()).toEqual([
      { text: "Three.", thread: location.threadTs },
    ]);
  });
});

// These cases need a fault or a timing that no edge can give: an input that
// arrives while the model request runs, which makes a Turn with two replies,
// or a child Conversation.
describe("Turn delivery with a test step", () => {
  const THREAD_TS = "1718123456.000000";
  const LOCATION = {
    id: "location:slack:T123:C123",
    provider: "slack",
    teamId: "T123",
    channelId: "C123",
    threadTs: THREAD_TS,
  } as const;

  let engine: TurnEngine;
  let fixture: LocalJuniorSqlFixture;
  let turnId: string;

  beforeEach(async () => {
    engine = await startTurnEngine();
    ({ fixture, turnId } = engine);
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ location: LOCATION, kind: "root" })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
    engine.queue.mount(
      DELIVERY_TOPIC,
      deliveryConsumer(engine.engineCtx, {
        getSlackAdapter: () => new FakeSlackAdapter({ botUserId: "U_BOT" }),
      }),
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

  function postedTexts() {
    return slackApiOutbox.messages().map((call) => ({
      text: call.params["text"],
      thread: call.params["thread_ts"],
    }));
  }

  /** Runs a step that replies `text` and commits "continue". */
  function advanceContinuingStep(text: string) {
    const step = stepWith([reply(text)]);
    // An input during the step continues the Turn, so it gets a next step.
    return engine.advance({
      ...step,
      client: {
        complete: async (request, signal) => {
          await engine.addTestInput("And how many failed?");
          return step.client.complete(request, signal);
        },
      },
    });
  }

  /** Runs a Turn whose two steps reply `first`, then `second`. */
  async function advanceTwoReplies(first: string, second: string) {
    await engine.addTestInput("How many Turns?");
    await advanceContinuingStep(first);
    await engine.advance(stepWith([reply(second)]));
  }

  it("posts the replies of one Turn to its Slack thread in order", async () => {
    await advanceTwoReplies("Three.", "None.");

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(handledDeliveries(engine.queue, turnId)).toBe(2);
    await expect(allSent(engine.engineCtx, CONVERSATION_ID)).resolves.toBe(
      true,
    );
    expect(postedTexts()).toEqual([
      { text: "Three.", thread: THREAD_TS },
      { text: "None.", thread: THREAD_TS },
    ]);
    await expect(
      readOutbox(engine.engineCtx, CONVERSATION_ID),
    ).resolves.toEqual([
      expect.objectContaining({
        turnId,
        location: LOCATION,
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
    queueSlackApiError("chat.postMessage", { error: "fatal_error" });

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
    expect(postedTexts()).toEqual([
      { text: "Three.", thread: THREAD_TS },
      { text: "None.", thread: THREAD_TS },
    ]);
  });

  it("records nothing for a child Conversation", async () => {
    const childId = `${CONVERSATION_ID}:child`;
    await fixture.sql
      .db()
      .insert(juniorConversations)
      .values(
        buildJuniorSqlConversation({
          conversationId: childId,
          parentConversationId: CONVERSATION_ID,
          rootConversationId: CONVERSATION_ID,
          kind: "task",
          location: LOCATION,
        }),
      );
    const childTurnId = randomUUID();
    await fixture.sql.db().insert(juniorTurns).values({
      id: childTurnId,
      conversationId: childId,
      actorIdentityId: "identity:actor",
      state: "queued",
      priority: 0,
      source: "slack",
    });
    const childInputId = randomUUID();
    await fixture.sql
      .db()
      .insert(juniorTurnInbox)
      .values({
        id: childInputId,
        conversationId: childId,
        turnId: childTurnId,
        actorIdentityId: "identity:actor",
        payload: { text: "How many Turns?" },
        idempotencyKey: `slack-event:${childInputId}`,
        sentAt: new Date(),
      });

    await engine.advance(stepWith([reply("Three.")]), undefined, childTurnId);
    await deliver();
    expect(handledDeliveries(engine.queue, childTurnId)).toBe(1);

    await expect(readOutbox(engine.engineCtx, childId)).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
  });

  it("posts a Turn's earlier reply when its delivery message was lost and a later step fails", async () => {
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after a "continue" commit, before the
    // delivery message is sent.
    vi.spyOn(engine.queue, "send").mockRejectedValueOnce(failure);
    await engine.addTestInput("How many Turns?");
    await expect(advanceContinuingStep("Three.")).rejects.toBe(failure);

    // The queue delivers the same step message again. It claims the queued
    // Turn, and the next step fails.
    // Injected fault: the model provider is overloaded.
    await engine.advance(stepWith([modelOverloaded()]));
    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    await deliver();
    await expect(allSent(engine.engineCtx, CONVERSATION_ID)).resolves.toBe(
      true,
    );

    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });
});
