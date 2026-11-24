// The harness of core's Turn engine integration tests. It runs the real path
// from an input to a Slack post: `scheduleInput`, the host's Turn step
// consumer with the host's prompt layouts, and the host's delivery consumer.
// Only the edges outside Junior are fakes: the AI emulator answers the model
// requests, MSW captures the Slack API calls, and an in-process queue holds
// each message until the test delivers it. Postgres is real. Each harness has
// its own Conversation, Actor and queue, so the ids keep tests apart in the
// shared database.
import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getChatConfig } from "@/chat/config";
import type { Location } from "@/chat/conversations/location";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { DELIVERY_TOPIC } from "@/core/delivery/topic";
import type { EngineContext } from "@/core/engine-context";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { scheduleInput } from "@/core/turn/schedule";
import type { ToolDefinition } from "@/core/tool";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import { turnStepConsumer } from "@/turn-steps/consumer";
import { deliveryConsumer } from "@/turn-steps/delivery";
import type { TurnInputPayload } from "@/turn-steps/prompt";
import { emulatedModelClient } from "./ai-emulator";
import { createInProcessQueue, type InProcessQueue } from "./in-process-queue";
import { slackApiOutbox } from "./slack-api-outbox";
import { FakeSlackAdapter } from "./slack-harness";
import { buildJuniorSqlConversation, createJuniorSqlFixture } from "./sql";

const LEASE_MS = 60_000;

type SlackLocation = Extract<Location, { provider: "slack" }>;

// A run that goes through more rounds than this is a loop, not a drain. One
// round delivers every due step message, then every due delivery message.
const MAX_ROUNDS = 20;

/** The Actor that sends a harness's inputs unless a test names another. */
export const ACTOR = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const satisfies TurnInputPayload["actor"];

/** An input that `send` scheduled: its Turn and its inbox row. */
type SentInput = { turnId: string; inputId: string };

/** One Slack post that delivery made in the harness's thread. */
type SlackPost = { text: unknown; thread: unknown };

/** One Conversation on the real Turn engine path, and its queue. */
export type TurnHarness = {
  conversationId: string;
  /** The Slack thread that the Conversation delivers to. */
  location: SlackLocation;
  /** The context that core runs with: the test database and this queue. */
  engineCtx: EngineContext;
  /** Holds the messages that core sends until the test delivers them. */
  queue: InProcessQueue;
  /** Schedules an input from the Actor, as a Source does. */
  send: (input: {
    text: string;
    actor?: TurnInputPayload["actor"];
  }) => Promise<SentInput>;
  /** Delivers the next due step message. Throws when none is due. */
  runStep: () => Promise<void>;
  /** Delivers due step and delivery messages until none is left. */
  runUntilIdle: () => Promise<void>;
  turn: (turnId: string) => Promise<typeof juniorTurns.$inferSelect>;
  /** The stored history events of the Conversation, oldest first. */
  events: () => ReturnType<
    ReturnType<typeof createSqlConversationEventStore>["loadCurrentHistory"]
  >;
  /** The Conversation history as the model reads it. */
  history: () => Promise<
    ReturnType<typeof projectConversationEvents>["messages"]
  >;
  /** The Slack posts in the Conversation's thread, oldest first. */
  slackPosts: () => SlackPost[];
  close: () => Promise<void>;
};

/**
 * Creates a root Slack Conversation and its queue for one test. The host's
 * Turn steps give the model `tools`.
 */
export async function createTurnHarness({
  tools = [],
}: { tools?: ToolDefinition[] } = {}): Promise<TurnHarness> {
  const fixture = await createJuniorSqlFixture();
  const db = fixture.sql.db();
  const threadTs = `${randomInt(1e9, 2e9)}.${randomInt(1e5, 1e6)}`;
  const conversationId = `slack:C123:${threadTs}`;
  const location: SlackLocation = {
    id: "location:slack:T123:C123",
    provider: "slack",
    teamId: "T123",
    channelId: "C123",
    threadTs,
  };
  const actorIdentityId = `identity:${randomUUID()}`;
  await db.insert(juniorIdentities).values({
    createdAt: new Date(),
    id: actorIdentityId,
    kind: "user",
    provider: "slack",
    providerSubjectId: `U${randomUUID()}`,
    providerTenantId: ACTOR.teamId,
    updatedAt: new Date(),
  });
  await db
    .insert(juniorConversations)
    .values(
      buildJuniorSqlConversation({ conversationId, location, kind: "root" }),
    );

  const queue = createInProcessQueue();
  const engineCtx: EngineContext = {
    executor: fixture.sql,
    queue,
    owner: "worker-a",
    leaseMs: LEASE_MS,
  };
  queue.mount(
    TURN_STEP_TOPIC,
    await turnStepConsumer(engineCtx, {
      client: emulatedModelClient(),
      bot: getChatConfig().bot,
      tools,
    }),
  );
  queue.mount(
    DELIVERY_TOPIC,
    deliveryConsumer(engineCtx, {
      getSlackAdapter: () => new FakeSlackAdapter({ botUserId: "U_BOT" }),
    }),
  );

  async function send(input: {
    text: string;
    actor?: TurnInputPayload["actor"];
  }): Promise<SentInput> {
    const payload: TurnInputPayload = {
      text: input.text,
      actor: input.actor ?? ACTOR,
    };
    const idempotencyKey = `slack-event:${randomUUID()}`;
    const { turnId } = await scheduleInput(engineCtx, {
      conversationId,
      actorIdentityId,
      payload,
      idempotencyKey,
      sentAt: new Date(),
      source: "slack",
      delivery: "interrupt",
    });
    const [row] = await db
      .select({ id: juniorTurnInbox.id })
      .from(juniorTurnInbox)
      .where(eq(juniorTurnInbox.idempotencyKey, idempotencyKey));
    return { turnId, inputId: row!.id };
  }

  async function runStep() {
    if (!(await queue.deliverNext(TURN_STEP_TOPIC))) {
      throw new Error("No step message is due");
    }
  }

  async function runUntilIdle() {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const steps = await queue.runUntilIdle(TURN_STEP_TOPIC);
      const deliveries = await queue.runUntilIdle(DELIVERY_TOPIC);
      if (steps + deliveries === 0) {
        return;
      }
    }
    throw new Error(`The Turn engine was not idle after ${MAX_ROUNDS} rounds`);
  }

  async function turn(turnId: string) {
    const [row] = await db
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    if (!row) {
      throw new Error(`No Turn ${turnId}`);
    }
    return row;
  }

  const events = () =>
    createSqlConversationEventStore(fixture.sql).loadCurrentHistory(
      conversationId,
    );

  return {
    conversationId,
    location,
    engineCtx,
    queue,
    send,
    runStep,
    runUntilIdle,
    turn,
    events,
    history: async () => projectConversationEvents(await events()).messages,
    slackPosts: () =>
      slackApiOutbox
        .messages()
        .filter((call) => call.params["thread_ts"] === threadTs)
        .map((call) => ({
          text: call.params["text"],
          thread: call.params["thread_ts"],
        })),
    close: () => fixture.close(),
  };
}
