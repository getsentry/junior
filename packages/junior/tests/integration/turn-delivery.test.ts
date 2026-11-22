import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { getQueueProvider } from "@/chat/queue/provider";
import {
  juniorConversations,
  juniorTurnOutbox,
  juniorTurns,
} from "@/db/schema";
import { deliveryConsumer } from "@/turn-steps/delivery";
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
  prepareWith,
  startTurnEngine,
  type TurnEngine,
} from "../fixtures/turn-engine";
import { queueSlackApiError } from "../msw/handlers/slack-api";

// Delivery of core Turn replies to Slack: a committed step sends a delivery
// message, and the app's delivery consumer posts the Turn's replies. The
// queue env must be set before chat config loads. Other Turn engine files
// use Redis databases 1 and 2, so this file uses 3.
vi.hoisted(() => {
  const redisUrl = new URL(
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382",
  );
  redisUrl.pathname = "/3";
  process.env["JUNIOR_QUEUE_PROVIDER"] = "bullmq";
  process.env["JUNIOR_QUEUE_REDIS_URL"] = redisUrl.href;
  process.env["JUNIOR_QUEUE_WORKER_CONCURRENCY"] = "1";
});

const THREAD_TS = "1718123456.000000";
const LOCATION = {
  id: "location:slack:T123:C123",
  provider: "slack",
  teamId: "T123",
  channelId: "C123",
  threadTs: THREAD_TS,
} as const;

const deliveryPayloadSchema = z.looseObject({ turnId: z.string() });

let engine: TurnEngine;
let fixture: LocalJuniorSqlFixture;
let turnId: string;
// The Turn ids of the delivery messages that the consumer finished.
let handled: string[];
let closeWorker: () => Promise<void>;

beforeEach(async () => {
  engine = await startTurnEngine();
  ({ fixture, turnId } = engine);
  await fixture.sql
    .db()
    .update(juniorConversations)
    .set({ location: LOCATION, kind: "root" })
    .where(eq(juniorConversations.conversationId, CONVERSATION_ID));
  handled = [];
  const consumer = deliveryConsumer({
    getSlackAdapter: () => new FakeSlackAdapter({ botUserId: "U_BOT" }),
  }).consumer;
  const provider = getQueueProvider();
  if (!provider.startWorker) {
    throw new Error("The BullMQ provider must start workers");
  }
  const worker = await provider.startWorker([
    {
      ...consumer,
      handler: async (payload, metadata) => {
        try {
          await consumer.handler(payload, metadata);
        } finally {
          const parsed = deliveryPayloadSchema.safeParse(payload);
          if (parsed.success) {
            handled.push(parsed.data.turnId);
          }
        }
      },
    },
  ]);
  closeWorker = () => worker.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeWorker();
  await engine.close();
});

async function waitFor(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for delivery");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Waits until the consumer has finished `count` delivery messages of a Turn. */
function handledDeliveries(count: number, forTurnId = turnId) {
  return waitFor(
    () => handled.filter((id) => id === forTurnId).length >= count,
  );
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

describe.skipIf(!hasJuniorPostgresTestDatabase())("Turn delivery", () => {
  it("posts the replies of one Turn to its Slack thread in order", async () => {
    await engine.addTestInput("How many Turns?");
    const first = prepareWith([reply("Three.")]);
    // An input during the step continues the Turn, so it gets a second step.
    await engine.advance({
      prepare: first.prepare,
      client: {
        complete: async (request, signal) => {
          await engine.addTestInput("And how many failed?");
          return first.client.complete(request, signal);
        },
      },
    });
    await engine.advance(prepareWith([reply("None.")]));

    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });
    await handledDeliveries(2);
    await waitFor(allSent);
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
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    // Stands in for a delivery of the Conversation that is still sending.
    const holder = fixture.sql.withLock(
      `junior:delivery:${CONVERSATION_ID}`,
      async () => {
        held();
        await released;
      },
    );
    await lockHeld;

    await engine.advance(prepareWith([reply("Three.")]));
    await handledDeliveries(1);

    expect(postedTexts()).toEqual([]);
    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "pending" }),
    ]);

    release();
    await holder;
    await waitFor(allSent);
    await handledDeliveries(2);
    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });

  it("retries a reply after a retryable Slack failure, then posts it", async () => {
    queueSlackApiError("chat.postMessage", { error: "fatal_error" });

    await engine.advance(prepareWith([reply("Three.")]));
    await waitFor(allSent);

    await expect(readOutbox()).resolves.toEqual([
      expect.objectContaining({ state: "sent", attempts: 1 }),
    ]);
    // The failed post and the post that Slack took.
    expect(postedTexts()).toEqual([
      { text: "Three.", thread: THREAD_TS },
      { text: "Three.", thread: THREAD_TS },
    ]);
  });

  it("records nothing for a Conversation without a Location", async () => {
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ location: null })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

    await engine.advance(prepareWith([reply("Three.")]));
    await handledDeliveries(1);

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

    await engine.advance(
      prepareWith([reply("Three.")]),
      undefined,
      childTurnId,
    );
    await handledDeliveries(1, childTurnId);

    await expect(readOutbox()).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
  });

  it("posts the reply on a redelivered step message after a crash before the delivery message", async () => {
    const failure = new Error("The queue is unreachable");
    // Stands in for the process dying after the end commit, before the
    // delivery message is sent.
    vi.spyOn(getQueueProvider(), "send").mockRejectedValueOnce(failure);

    await expect(engine.advance(prepareWith([reply("Three.")]))).rejects.toBe(
      failure,
    );
    await expect(engine.readTurn()).resolves.toMatchObject({
      state: "completed",
    });

    // The queue delivers the same step message again. Its claim misses.
    await engine.advance(prepareWith([]));
    await waitFor(allSent);

    expect(postedTexts()).toEqual([{ text: "Three.", thread: THREAD_TS }]);
  });

  it("posts nothing while the Conversation's Delivery is paused", async () => {
    await fixture.sql
      .db()
      .update(juniorConversations)
      .set({ deliveryPausedAt: new Date() })
      .where(eq(juniorConversations.conversationId, CONVERSATION_ID));

    await engine.advance(prepareWith([reply("Three.")]));
    await handledDeliveries(1);

    await expect(readOutbox()).resolves.toEqual([]);
    expect(postedTexts()).toEqual([]);
  });
});
