import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_TOPIC } from "@/core/delivery/queue";
import {
  juniorConversations,
  juniorTurnInbox,
  juniorTurnOutbox,
  juniorTurns,
} from "@/db/schema";
import { deliveryConsumer } from "@/turn-steps/delivery";
import { modelOverloaded } from "../fixtures/ai-emulator";
import { createAssistantMessage } from "../fixtures/model-stream";
import { slackApiOutbox } from "../fixtures/slack-api-outbox";
import { FakeSlackAdapter } from "../fixtures/slack-harness";
import {
  buildJuniorSqlConversation,
  hasJuniorPostgresTestDatabase,
  type LocalJuniorSqlFixture,
} from "../fixtures/sql";
import {
  CONVERSATION_ID,
  messageTurnId,
  prepareWith,
  startTurnEngine,
  type TurnEngine,
} from "../fixtures/turn-engine";
import {
  queueSlackApiError,
  queueSlackRateLimit,
} from "../msw/handlers/slack-api";

// Delivery of core Turn replies to Slack: a committed step sends a delivery
// message, and the app's delivery consumer posts the Turn's replies. The test
// delivers the messages from the in-process queue.

const THREAD_TS = "1718123456.000000";
const LOCATION = {
  id: "location:slack:T123:C123",
  provider: "slack",
  teamId: "T123",
  channelId: "C123",
  threadTs: THREAD_TS,
} as const;

// Longer than the longest delivery backoff, so every delayed check is due.
const AFTER_EVERY_BACKOFF_SECONDS = 60;

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
    deliveryConsumer(engine.engineCtx, {
      getSlackAdapter: () => new FakeSlackAdapter({ botUserId: "U_BOT" }),
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/** Counts the delivery messages of a Turn that the consumer finished. */
function handledDeliveries(forTurnId = turnId) {
  return engine.queue
    .delivered(DELIVERY_TOPIC)
    .filter((message) => messageTurnId(message.payload) === forTurnId).length;
}

function readOutbox() {
  return fixture.sql
    .db()
    .select()
    .from(juniorTurnOutbox)
    .orderBy(juniorTurnOutbox.eventSeq);
}

async function allSent() {
  const rows = await readOutbox();
  return rows.length > 0 && rows.every((row) => row.state === "sent");
}

function postedTexts() {
  return slackApiOutbox.messages().map((call) => ({
    text: call.params["text"],
    thread: call.params["thread_ts"],
  }));
}

function reply(text: string) {
  return createAssistantMessage({ type: "text", text });
}

/** Runs a step that replies `text` and commits "continue". */
function advanceContinuingStep(text: string) {
  const step = prepareWith([reply(text)]);
  // An input during the step continues the Turn, so it gets a next step.
  return engine.advance({
    prepare: step.prepare,
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
  await engine.advance(prepareWith([reply(second)]));
}

/**
 * Holds the Conversation's delivery lock, as a delivery that is still
 * sending does, until the returned function is called.
 */
async function holdDeliveryLock(): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = fixture.sql.withLock(
    `junior:delivery:${CONVERSATION_ID}`,
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

describe.skipIf(!hasJuniorPostgresTestDatabase())("Turn delivery", () => {
  it("posts the replies of one Turn to its Slack thread in order", async () => {
    await advanceTwoReplies("Three.", "None.");

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(handledDeliveries()).toBe(2);
    await expect(allSent()).resolves.toBe(true);
    expect(postedTexts()).toEqual([
      { text: "Three.", thread: THREAD_TS },
      { text: "None.", thread: THREAD_TS },
    ]);
    await expect(readOutbox()).resolves.toEqual([
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

  it("checks back when another delivery holds the Conversation, and posts the reply once", async () => {
    const release = await holdDeliveryLock();

    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));
    await deliver();
    expect(handledDeliveries()).toBe(1);

    expect(postedTexts()).toEqual([]);
    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    await release();
    await deliverAfterBackoff();
    await expect(allSent()).resolves.toBe(true);
    expect(handledDeliveries()).toBe(2);
    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });

  it("retries a reply after a retryable Slack failure, then posts it", async () => {
    queueSlackApiError("chat.postMessage", { error: "fatal_error" });

    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));
    await deliver();
    await deliverAfterBackoff();

    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // The failed post and the post that Slack took.
    expect(postedTexts()).toEqual([
      { text: "Three.", thread: THREAD_TS },
      { text: "Three.", thread: THREAD_TS },
    ]);
  });

  it("fails a reply after its fifth retryable failure, then posts the next reply", async () => {
    const release = await holdDeliveryLock();
    await advanceTwoReplies("Three.", "None.");
    await deliver();
    expect(handledDeliveries()).toBe(2);
    const [head] = await readOutbox();
    // Four retryable failures so far, so the next one is the fifth.
    await fixture.sql
      .db()
      .update(juniorTurnOutbox)
      .set({ attempts: 4 })
      .where(eq(juniorTurnOutbox.id, head!.id));
    queueSlackApiError("chat.postMessage", { error: "fatal_error" });

    await release();
    await deliverAfterBackoff();

    await expect(readOutbox()).resolves.toEqual([
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

  it("waits the Retry-After of a Slack rate limit before it tries a reply again", async () => {
    // Every try of one post: the Slack client retries a rate limit itself.
    for (let attempt = 0; attempt < 3; attempt++) {
      queueSlackRateLimit("chat.postMessage", 2);
    }

    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));

    await deliver();

    // The backoff after a first failure is 1 s, so 2 s is the Retry-After.
    expect(engine.queue.pending(DELIVERY_TOPIC)).toEqual([
      expect.objectContaining({ delaySeconds: 2, due: false }),
    ]);
    engine.queue.advanceTime(2);
    await deliver();
    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // Three rate-limited posts, then the post that Slack took.
    expect(postedTexts()).toHaveLength(4);
  }, 20_000);

  it("records nothing for a Conversation without a Location", async () => {
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ location: null })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(handledDeliveries()).toBe(1);

    await expect(readOutbox()).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
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

    await engine.advance(
      prepareWith([reply("Three.")]),
      undefined,
      childTurnId,
    );
    await deliver();
    expect(handledDeliveries(childTurnId)).toBe(1);

    await expect(readOutbox()).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
  });

  it("posts the reply on a redelivered step message after a crash before the delivery message", async () => {
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after the end commit, before the
    // delivery message is sent.
    vi.spyOn(engine.queue, "send").mockRejectedValueOnce(failure);

    await engine.addTestInput("How many Turns?");
    await expect(engine.advance(prepareWith([reply("Three.")]))).rejects.toBe(
      failure,
    );
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });

    // The queue delivers the same step message again. Its claim misses.
    await engine.advance(prepareWith([]));
    await deliver();
    await expect(allSent()).resolves.toBe(true);

    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
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
    await engine.advance(prepareWith([modelOverloaded()]));
    await expect(engine.readTurn()).resolves.toMatchObject({ state: "failed" });
    await deliver();
    await expect(allSent()).resolves.toBe(true);

    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });

  it("posts nothing while the Conversation's Delivery is paused", async () => {
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ deliveryPausedAt: new Date() })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await deliver();
    expect(handledDeliveries()).toBe(1);

    await expect(readOutbox()).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
  });

  it("still posts a reply recorded before the Conversation's Delivery was paused", async () => {
    const release = await holdDeliveryLock();
    await engine.addTestInput("How many Turns?");
    await engine.advance(prepareWith([reply("Three.")]));
    await deliver();
    expect(handledDeliveries()).toBe(1);
    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ deliveryPausedAt: new Date() })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
    await release();
    await deliverAfterBackoff();
    await expect(allSent()).resolves.toBe(true);

    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });
});
