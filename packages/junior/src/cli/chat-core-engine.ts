/**
 * `junior chat --engine core -p`: one message through the core Turn engine.
 *
 * The CLI is the Source. It runs a local Vercel Queues server that pushes
 * each Turn step message and Turn-ended message to their consumers in this
 * process, and reads the reply from the stored history when the Turn ends.
 * The Turn has no Destination, so the history is the only place that has
 * the reply.
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
import { TURN_ENDED_TOPIC, TURN_STEP_TOPIC } from "@/core/turn/topic";
import { scheduleInput } from "@/core/turn/schedule";
import { juniorTurns } from "@/db/schema";
import type { TurnState } from "@/db/schema/turns";
import type { Delivery } from "@/delivery/deliver";
import {
  createGatewayModelClient,
  turnStepConsumer,
} from "@/turn-steps/consumer";
import { createEngineContext } from "@/turn-steps/engine-context";
import { turnGroupKey } from "@/turn-steps/group-key";
import { turnEndedConsumer } from "@/turn-steps/turn-ended";
import { turnTools } from "@/turn-steps/tools";
import type { TurnInputPayload } from "@/turn-steps/input-payload";

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
const TURN_ENDED_CALLBACK_URL = `http://cli.localhost/${TURN_ENDED_TOPIC}`;

// The CLI's Turn has no Destination, so Delivery has no reply to send.
const NO_DELIVERY: Delivery = {
  send: async () => {
    throw new Error("The CLI has no Destination to send a reply to");
  },
};

// This stops the wait for a Turn whose step message never arrives.
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
  endHandled: () => boolean,
): Promise<EndedTurn> {
  const deadline = Date.now() + TURN_WAIT_TIMEOUT_MS;
  /* oxlint-disable no-await-in-loop -- Each read waits for the one before it. */
  while (Date.now() < deadline) {
    const [turn] = await executor
      .db()
      .select({ state: juniorTurns.state, endReason: juniorTurns.endReason })
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    if (turn && ENDED_STATES.has(turn.state) && endHandled()) {
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
      tools: turnTools,
    }),
  );
  // The server stops its pushes when it closes, so the CLI waits until the
  // Turn-ended consumer has handled the end, such as its end event.
  let endHandled = false;
  const turnEnds = turnEndedConsumer(engineCtx, NO_DELIVERY);
  const turnEndedCallback = engineCtx.queue.createCallback({
    ...turnEnds,
    handler: async (payload, metadata) => {
      await turnEnds.handler(payload, metadata);
      endHandled = true;
    },
  });
  const server = await startLocalVercelQueueServer({
    consumers: [
      {
        consumerGroup: "local",
        topic: TURN_STEP_TOPIC,
        url: TURN_STEP_CALLBACK_URL,
      },
      {
        consumerGroup: "local",
        topic: TURN_ENDED_TOPIC,
        url: TURN_ENDED_CALLBACK_URL,
      },
    ],
    fetch: async (request) =>
      request.url === TURN_STEP_CALLBACK_URL
        ? turnStepCallback(request)
        : request.url === TURN_ENDED_CALLBACK_URL
          ? turnEndedCallback(request)
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
    const source = {
      kind: "local",
      visibility: "private",
      conversationId: args.conversationId,
    } as const;
    const { turnId } = await scheduleInput(engineCtx, {
      conversationId: args.conversationId,
      // The local CLI has no per-person id, so it uses the system Identity.
      actorIdentityId: SYSTEM_IDENTITY_ID,
      groupKey: turnGroupKey(SYSTEM_IDENTITY_ID, source),
      payload,
      idempotencyKey: `local-cli:${randomUUID()}`,
      sentAt: new Date(),
      source,
      // The CLI reads the Conversation history, so that is the answer.
      destination: null,
      delivery: "defer",
    });
    const turn = await waitForTurnEnd(engineCtx, turnId, () => endHandled);
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
