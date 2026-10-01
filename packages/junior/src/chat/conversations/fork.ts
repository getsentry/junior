import { eq } from "drizzle-orm";
import { loadTurnProjection } from "./projection";
import { contextProvenance } from "./provenance";
import { withConversationEventLock } from "./sql/event-lock";
import {
  createConversationId,
  recordWebConversationActivity,
  webActorFromEmail,
} from "./web-input";
import {
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import {
  historyItemFromPiMessage,
  piMessageFromHistoryItem,
} from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { juniorConversations } from "@/db/schema";

/** Event key prefix for copied history. Model usage reports skip these events. */
export const FORK_HISTORY_KEY_PREFIX = "fork:history:";

const FORK_NOTE =
  "This Conversation is a fork. The earlier messages are copied from another Conversation. Sandbox files, active work, approvals, credentials, Watches, Automations, and the delivery location were not copied. Earlier file paths and runtime context belong to the source Conversation. Verify files in the current Sandbox before you use them.";

/** An expected fork request failure, such as a reply without saved history. */
export class ConversationForkError extends Error {}

/**
 * Create a new web root Conversation from the agent history of a source
 * Conversation, through one completed assistant reply.
 *
 * Retries with the same requester and key return the same Conversation.
 */
export async function forkConversation(input: {
  sourceConversationId: string;
  messageId: string;
  actorEmail: string;
  actorName?: string;
  idempotencyKey: string;
}): Promise<{ conversationId: string }> {
  const conversationId = createConversationId({
    actorEmail: input.actorEmail,
    idempotencyKey: JSON.stringify([
      "fork",
      input.sourceConversationId,
      input.idempotencyKey,
    ]),
  });
  const executor = getSqlExecutor();
  const events = getConversationEventStore();
  const store = getConversationStore();
  // The source lock keeps the fork point stable against appends and
  // compaction. Both locks share one transaction, so a fork row exists only
  // with its complete history. A retry finds that row and returns it.
  return withConversationEventLock(executor, input.sourceConversationId, () =>
    withConversationEventLock(executor, conversationId, async () => {
      if (await store.get({ conversationId })) return { conversationId };

      const source = await store.get({
        conversationId: input.sourceConversationId,
      });
      if (!source || source.transcriptPurgedAtMs !== undefined) {
        throw new ConversationForkError(
          "The source history is no longer available.",
        );
      }
      if (source.parentConversationId) {
        throw new ConversationForkError(
          "You cannot fork a child conversation.",
        );
      }

      // Delivery saves this key with the reply's agent message. Do not guess
      // from timestamps: a fallback reply can have no agent history.
      const boundary = await events.loadByIdempotencyKey(
        input.sourceConversationId,
        `message:${input.messageId}:agent`,
      );
      const reply =
        boundary?.data.type === "assistant_message"
          ? piMessageFromHistoryItem(boundary.data)
          : undefined;
      if (
        !boundary ||
        reply?.role !== "assistant" ||
        reply.stopReason !== "stop" ||
        reply.content.some((part) => part.type === "toolCall")
      ) {
        throw new ConversationForkError(
          "Choose a completed assistant reply with saved agent history.",
        );
      }

      // Use the history version at the fork point, also after a later compaction.
      const projection = await loadTurnProjection({
        conversationId: input.sourceConversationId,
        committedSeq: boundary.seq,
        includeTail: false,
      });
      if (!projection?.messages.length) {
        throw new ConversationForkError(
          "The selected history is no longer available.",
        );
      }
      if (hasUnfinishedToolCalls(projection.messages)) {
        throw new ConversationForkError(
          "This history has unfinished tool calls. Choose another reply.",
        );
      }

      const nowMs = Date.now();
      await recordWebConversationActivity({
        actor: webActorFromEmail(input.actorEmail, {
          ...(input.actorName ? { fullName: input.actorName } : undefined),
        }),
        conversationId,
        nowMs,
        rootVisibility: source.visibility === "public" ? "public" : "private",
      });
      await executor
        .db()
        .update(juniorConversations)
        .set({
          forkedFromConversationId: source.conversationId,
          title: source.title ? `Fork: ${source.title}` : "Forked conversation",
        })
        .where(eq(juniorConversations.conversationId, conversationId));
      // Copy the model messages exactly, with their attribution. Source
      // authors do not become participants of the fork.
      await events.append(conversationId, [
        ...projection.messages.map((message, index) => ({
          idempotencyKey: `${FORK_HISTORY_KEY_PREFIX}${index}`,
          createdAtMs: nowMs,
          data: historyItemFromPiMessage(
            message,
            projection.provenance[index] ?? contextProvenance,
          ),
        })),
        {
          idempotencyKey: "fork:note",
          createdAtMs: nowMs,
          data: {
            type: "user_message",
            provenance: contextProvenance,
            content: [{ type: "text", text: FORK_NOTE }],
            timestamp: nowMs,
          },
        },
      ]);
      return { conversationId };
    }),
  );
}

function hasUnfinishedToolCalls(messages: readonly PiMessage[]): boolean {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") pending.add(part.id);
      }
    } else if (message.role === "toolResult") {
      pending.delete(message.toolCallId);
    }
  }
  return pending.size > 0;
}
