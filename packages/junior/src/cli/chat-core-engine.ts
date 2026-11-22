/**
 * `junior chat --engine core -p`: one message through the core Turn engine.
 *
 * The CLI is the Source. It schedules the message as an input, runs the Turn
 * step consumer on a BullMQ worker in this process, and reads the reply from
 * the stored history when the Turn ends. The engine has no Delivery yet, so
 * the history is the only place that has the reply.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { localDestinationSchema } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { getChatConfig } from "@/chat/config";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { getConversationStore, getSqlExecutor } from "@/chat/db";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { getQueueProvider } from "@/chat/queue/provider";
import { scheduleInput } from "@/core/turn/schedule";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorTurns } from "@/db/schema";
import type { TurnState } from "@/db/schema/turns";
import { turnStepConsumer } from "@/turn-steps/consumer";
import type { TurnInputPayload } from "@/turn-steps/prepare";

const LOCAL_ACTOR: TurnInputPayload["actor"] = {
  fullName: "Local CLI",
  platform: "local",
  userId: "local-cli",
  userName: "local",
};

const TURN_POLL_INTERVAL_MS = 250;

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
  executor: JuniorSqlDatabase,
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
  executor: JuniorSqlDatabase,
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
  const queue = getQueueProvider();
  if (getChatConfig().queue.provider !== "bullmq" || !queue.startWorker) {
    throw new Error(
      "--engine core runs its steps on a BullMQ worker. Set JUNIOR_QUEUE_PROVIDER=bullmq and JUNIOR_QUEUE_REDIS_URL.",
    );
  }
  const executor = getSqlExecutor();
  const worker = await queue.startWorker([turnStepConsumer.consumer]);
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
    const { turnId } = await scheduleInput(executor, {
      conversationId: args.conversationId,
      // The local CLI has no per-person id, so it uses the system Identity.
      actorIdentityId: SYSTEM_IDENTITY_ID,
      payload,
      idempotencyKey: `local-cli:${randomUUID()}`,
      sentAt: new Date(),
      source: "local",
    });
    const turn = await waitForTurnEnd(executor, turnId);
    if (turn.state !== "completed") {
      return {
        outcome: turn.state === "cancelled" ? "cancelled" : "failed",
        reason: turn.endReason ?? turn.state,
      };
    }
    return {
      outcome: "completed",
      reply: await lastAssistantText(executor, args.conversationId),
    };
  } finally {
    await worker.close();
  }
}
