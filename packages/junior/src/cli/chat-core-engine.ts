/**
 * `junior chat --engine core -p`: one message through the core Turn engine.
 *
 * The CLI is the Source. It schedules the message as an input, runs a local
 * Vercel Queues server that pushes each Turn step message to the Turn step
 * consumer in this process, and reads the reply from the stored history when
 * the Turn ends. The engine has no Delivery yet, so
 * the history is the only place that has the reply.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { localDestinationSchema } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getChatConfig } from "@/chat/config";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { getConversationStore } from "@/chat/db";
import { startLocalVercelQueueServer } from "@/chat/queue/local-server";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import type { EngineContext } from "@/core/engine-context";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
import { scheduleInput } from "@/core/turn/schedule";
import { juniorTurns } from "@/db/schema";
import type { TurnState } from "@/db/schema/turns";
import {
  createGatewayModelClient,
  turnStepConsumer,
} from "@/turn-steps/consumer";
import { createEngineContext } from "@/turn-steps/engine-context";
import type { TurnInputPayload } from "@/turn-steps/prompt";

const LOCAL_ACTOR: TurnInputPayload["actor"] = {
  fullName: "Local CLI",
  platform: "local",
  userId: "local-cli",
  userName: "local",
};

const TURN_POLL_INTERVAL_MS = 250;

// The local queue server pushes to this URL, and this process answers it
// without a network call.
const TURN_STEP_CALLBACK_URL = `http://cli.localhost/${TURN_STEP_TOPIC}`;

// A Turn without tools makes one model request. This stops the wait for a
// Turn whose step message never arrives.
const TURN_WAIT_TIMEOUT_MS = 10 * 60_000;

const ENDED_STATES: ReadonlySet<TurnState> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** The reply of a completed Turn, or why the Turn did not complete. */
export type CoreEngineResult =
  | { outcome: "completed"; reply: string }
  | { outcome: "failed" | "cancelled"; reason: string };

type EndedTurn = { state: TurnState; endReason: string | null };

async function waitForTurnEnd(
  { executor }: Pick<EngineContext, "executor">,
  turnId: string,
): Promise<EndedTurn> {
  const deadline = Date.now() + TURN_WAIT_TIMEOUT_MS;
  /* oxlint-disable no-await-in-loop -- Each read waits for the one before it. */
  while (Date.now() < deadline) {
    const [turn] = await executor
      .db()
      .select({ state: juniorTurns.state, endReason: juniorTurns.endReason })
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    if (turn && ENDED_STATES.has(turn.state)) {
      return turn;
    }
    await sleep(TURN_POLL_INTERVAL_MS);
  }
  /* oxlint-enable no-await-in-loop */
  throw new Error(
    `Turn ${turnId} did not end within ${TURN_WAIT_TIMEOUT_MS} ms`,
  );
}

async function lastAssistantText(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
): Promise<string> {
  const events =
    await createSqlConversationEventStore(executor).loadCurrentHistory(
      conversationId,
    );
  const reply = projectConversationEvents(events)
    .messages.filter((message) => message.role === "assistant")
    .at(-1);
  return (reply?.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}

/**
 * Sends one message to a new local Conversation through the core Turn
 * engine, and returns the reply when its Turn ends.
 */
export async function runCoreEnginePrompt(args: {
  conversationId: string;
  message: string;
}): Promise<CoreEngineResult> {
  const config = getChatConfig();
  const engineCtx = createEngineContext(config);
  const { apiUrl } = config.queue;
  const port = apiUrl ? Number(new URL(apiUrl).port) : 0;
  if (!port) {
    throw new Error(
      "--engine core runs a local queue server. Set JUNIOR_QUEUE_API_URL to a free local URL with a port, such as http://127.0.0.1:4100.",
    );
  }
  const turnStepCallback = engineCtx.queue.createCallback(
    await turnStepConsumer(engineCtx, {
      client: createGatewayModelClient(),
      bot: config.bot,
      // Core Turns have no tools yet.
      tools: [],
    }),
  );
  const server = await startLocalVercelQueueServer({
    consumers: [
      {
        consumerGroup: "local",
        topic: TURN_STEP_TOPIC,
        url: TURN_STEP_CALLBACK_URL,
      },
    ],
    fetch: async (request) =>
      request.url === TURN_STEP_CALLBACK_URL
        ? turnStepCallback(request)
        : new Response(null, { status: 404 }),
    port,
  });
  try {
    await getConversationStore().recordActivity({
      conversationId: args.conversationId,
      destination: localDestinationSchema.parse({
        platform: "local",
        conversationId: args.conversationId,
      }),
      nowMs: Date.now(),
      source: "local",
      visibility: "private",
    });
    const payload: TurnInputPayload = {
      text: args.message,
      actor: LOCAL_ACTOR,
    };
    const { turnId } = await scheduleInput(engineCtx, {
      conversationId: args.conversationId,
      // The local CLI has no per-person id, so it uses the system Identity.
      actorIdentityId: SYSTEM_IDENTITY_ID,
      payload,
      idempotencyKey: `local-cli:${randomUUID()}`,
      sentAt: new Date(),
      source: "local",
      delivery: "defer",
    });
    const turn = await waitForTurnEnd(engineCtx, turnId);
    if (turn.state !== "completed") {
      return {
        outcome: turn.state === "cancelled" ? "cancelled" : "failed",
        reason: turn.endReason ?? turn.state,
      };
    }
    return {
      outcome: "completed",
      reply: await lastAssistantText(engineCtx, args.conversationId),
    };
  } finally {
    await server.close();
  }
}
