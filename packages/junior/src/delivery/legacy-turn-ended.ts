// LEGACY COMPAT: core writes only agent history, but main's readers, such as
// the dashboard, status, ACP and the eval fixture, read the visible messages
// and Turn lifecycle events. This writes them for a core Turn's replies and
// end, with main's shapes and idempotency keys, as `commitAcceptedReply` and
// the Turn lifecycle do. Delete it once readers read `junior_turns`.
import type { Destination } from "@sentry/junior-plugin-api";
import { and, eq, inArray } from "drizzle-orm";
import { botConfig } from "@/chat/config";
import type { NewConversationEvent } from "@/chat/conversations/history";
import { toStoredConversationMessage } from "@/chat/conversations/messages";
import { claimProviderConversation } from "@/chat/conversations/sql/bindings";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { startLocationThread } from "@/chat/conversations/sql/location";
import { turnTerminalKey } from "@/chat/conversations/turn-lifecycle";
import { normalizeConversationText } from "@/chat/services/conversation-memory";
import type { EngineContext } from "@/core/engine-context";
import type { TurnEndedMessage } from "@/core/turn/ended";
import { findTurnDestination, findTurnInputs } from "@/core/turn/inbox";
import { findTurnReplies, replyText } from "@/core/turn/replies";
import { findTurn, type TurnRecord } from "@/core/turn/state";
import { juniorConversationEvents, juniorTurnOutbox } from "@/db/schema";
import { legacyInputMessageId } from "@/turn-steps/legacy-message-id";

type Executor = Pick<EngineContext, "executor">;

// Main's `turn_failed` takes only a Sentry event id. Core stores any id, and
// one that main rejects must not keep the Turn-ended message failing.
const SENTRY_EVENT_ID = /^[a-f0-9]{32}$/i;

/** One reply of a core Turn, as main's visible message records it. */
type LegacyReply = {
  eventSeq: number;
  text: string;
  createdAtMs: number;
  destination?: Destination;
  providerMessageId?: string;
};

/**
 * LEGACY COMPAT: after the sender posted a reply, writes its visible
 * `message`, the `message_handled` events, and for Slack the thread claim.
 * Call it in the transaction that marks the reply sent.
 */
export async function writeLegacyReplyDelivered(
  { executor }: Executor,
  args: {
    conversationId: string;
    turnId: string;
    reply: LegacyReply;
    providerConversationId?: string;
  },
): Promise<void> {
  await createSqlConversationEventStore(executor).append(
    args.conversationId,
    await legacyReplyEvents({ executor }, args.conversationId, args.turnId, [
      args.reply,
    ]),
  );
  const { destination } = args.reply;
  if (destination?.platform !== "slack" || !args.providerConversationId) {
    return;
  }
  const binding = {
    conversationId: args.conversationId,
    provider: "slack",
    providerTenantId: destination.teamId,
    providerDestinationId: destination.channelId,
    providerConversationId: args.providerConversationId,
  };
  // A reply into a thread that another Conversation started leaves it there.
  if (await claimProviderConversation(executor, binding)) {
    await startLocationThread(executor, binding);
  }
}

/**
 * LEGACY COMPAT: writes the end event of an ended Turn once its replies are
 * settled. A Turn with no Destination gets its reply messages here, in the
 * same commit and before the end. A Turn with a pending reply waits for the
 * Turn-ended message that its delivery sends again.
 */
export async function writeLegacyTurnEnded(
  { executor }: Executor,
  message: TurnEndedMessage,
): Promise<void> {
  const turn = await findTurn({ executor }, message.turnId);
  const endedAt = turn?.endedAt;
  // A Turn that never ran has no `turn_started`, so it gets no end either.
  if (!turn || !endedAt || !turn.startedAt) {
    return;
  }
  const [pending] = await executor
    .db()
    .select({ id: juniorTurnOutbox.id })
    .from(juniorTurnOutbox)
    .where(
      and(
        eq(juniorTurnOutbox.turnId, turn.turnId),
        eq(juniorTurnOutbox.state, "pending"),
      ),
    )
    .limit(1);
  if (pending) {
    return;
  }
  const replies = await findTurnReplies(
    { executor },
    turn.conversationId,
    turn.turnId,
  );
  const undelivered =
    (await findTurnDestination({ executor }, turn.turnId)) === null
      ? replies.flatMap((row) => {
          const text = replyText(row);
          return text
            ? [
                {
                  eventSeq: row.seq,
                  text,
                  createdAtMs: row.createdAt.getTime(),
                },
              ]
            : [];
        })
      : [];
  await executor.transaction(async () =>
    createSqlConversationEventStore(executor).append(turn.conversationId, [
      ...(await legacyReplyEvents(
        { executor },
        turn.conversationId,
        turn.turnId,
        undelivered,
      )),
      legacyEndEvent(turn, endedAt.getTime(), replies.length > 0),
    ]),
  );
}

/**
 * Main's events for delivered replies: each reply's `message` and its
 * `message_handled`, then `message_handled` for the Turn's input messages.
 * An input message is marked only once its `message` exists, because a
 * `message_handled` before its `message` breaks main's projection.
 */
async function legacyReplyEvents(
  { executor }: Executor,
  conversationId: string,
  turnId: string,
  replies: LegacyReply[],
): Promise<NewConversationEvent[]> {
  if (replies.length === 0) {
    return [];
  }
  const inputMessageIds = (await findTurnInputs({ executor }, turnId)).map(
    (input) => legacyInputMessageId(input.inputId),
  );
  const stored = await executor
    .db()
    .select({ key: juniorConversationEvents.idempotencyKey })
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        inArray(
          juniorConversationEvents.idempotencyKey,
          inputMessageIds.map((id) => `message:${id}`),
        ),
      ),
    );
  const storedKeys = new Set(stored.map((row) => row.key));
  const handledAtMs = Date.now();
  const handled = (messageId: string): NewConversationEvent => ({
    idempotencyKey: `message:${messageId}:handled`,
    createdAtMs: handledAtMs,
    data: { type: "message_handled", messageId },
  });
  return [
    ...replies.flatMap((reply) => {
      const message = toStoredConversationMessage({
        // Main's assistant message ids start with `<turnId>:assistant:`.
        id: `${turnId}:assistant:${reply.eventSeq}`,
        role: "assistant",
        text: normalizeConversationText(reply.text),
        createdAtMs: reply.createdAtMs,
        author: { userName: botConfig.userName, isBot: true },
        ...(reply.destination?.platform === "slack"
          ? {
              meta: {
                source: "slack" as const,
                ...(reply.providerMessageId
                  ? { slackTs: reply.providerMessageId }
                  : undefined),
              },
            }
          : undefined),
      });
      return [
        {
          idempotencyKey: `message:${message.messageId}`,
          createdAtMs: message.createdAtMs,
          data: {
            type: "message" as const,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.meta ? { meta: message.meta } : undefined),
          },
        },
        handled(message.messageId),
      ];
    }),
    ...inputMessageIds
      .filter((id) => storedKeys.has(`message:${id}`))
      .map(handled),
  ];
}

/** Main's end event of an ended Turn, from its core state. */
function legacyEndEvent(
  turn: TurnRecord,
  endedAtMs: number,
  replied: boolean,
): NewConversationEvent {
  const base = {
    idempotencyKey: turnTerminalKey(turn.turnId),
    createdAtMs: endedAtMs,
  };
  if (turn.state === "failed") {
    return {
      ...base,
      data: {
        type: "turn_failed",
        turnId: turn.turnId,
        failureCode: turn.failureCode ?? "agent_run_failed",
        ...(turn.failureReason
          ? { failureReason: turn.failureReason }
          : undefined),
        ...(turn.failureEventId && SENTRY_EVENT_ID.test(turn.failureEventId)
          ? { eventId: turn.failureEventId }
          : undefined),
      },
    };
  }
  // A stopped Turn and a superseded Turn both end as cancelled.
  return {
    ...base,
    data: {
      type: "turn_completed",
      turnId: turn.turnId,
      outcome:
        turn.state === "cancelled"
          ? "cancelled"
          : replied
            ? "success"
            : "no_reply",
    },
  };
}
