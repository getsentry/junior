import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ConversationEvent } from "./history";
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
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";

/** Event key of the agent note that follows the copied events in a fork. */
const FORK_NOTE_KEY = "fork:note";

const forkNote = alias(juniorConversationEvents, "fork_note");

/**
 * SQL filter for event rows that a fork did not copy from its source. Usage
 * and cost reports use it, so copied model calls count only in the source.
 */
export function notCopiedByFork(): SQL {
  return sql`not exists (
    select 1 from ${juniorConversationEvents} as ${sql.identifier("fork_note")}
    where ${forkNote.conversationId} = ${juniorConversationEvents.conversationId}
      and ${forkNote.idempotencyKey} = ${FORK_NOTE_KEY}
      and ${forkNote.seq} > ${juniorConversationEvents.seq}
  )`;
}

// These events hold credentials, approvals, provider connections, or plugin
// state of the source actor. A fork does not copy them.
const UNCOPIED_EVENT_TYPES = new Set<ConversationEvent["data"]["type"]>([
  "authorization_completed",
  "authorization_requested",
  "guardian_action_reviewed",
  "mcp_provider_connected",
  "mcp_provider_connected_unowned",
  "structured_event",
  "unknown",
]);

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
      await copyForkEvents({
        sourceConversationId: source.conversationId,
        conversationId,
        events: await events.loadHistory(source.conversationId),
        boundarySeq: boundary.seq,
        messageId: input.messageId,
      });
      await events.append(conversationId, [
        {
          idempotencyKey: FORK_NOTE_KEY,
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

/**
 * Copy the source event rows through the selected reply. Copies keep their
 * sequence, author, timestamp, key, and payload, so the fork shows the same
 * transcript and event log, and seq references in compactions stay valid.
 * Later updates of copied Messages and the end of copied Turns are also
 * copied, so that no copied item stays open in the fork.
 */
async function copyForkEvents(args: {
  sourceConversationId: string;
  conversationId: string;
  events: readonly ConversationEvent[];
  boundarySeq: number;
  messageId: string;
}): Promise<void> {
  const reply = args.events.find(
    (event) =>
      event.data.type === "message" &&
      event.data.role === "assistant" &&
      event.data.messageId === args.messageId,
  );
  const cutoffSeq = Math.max(args.boundarySeq, reply?.seq ?? -1);
  const messageIds = new Set<string>();
  const turnIds = new Set<string>();
  const seqs: number[] = [];
  let historyVersion = 0;
  for (const event of args.events) {
    const data = event.data;
    if (UNCOPIED_EVENT_TYPES.has(data.type)) continue;
    if (event.seq <= cutoffSeq) {
      if (data.type === "message") messageIds.add(data.messageId);
      if (data.type === "turn_started") turnIds.add(data.turnId);
      historyVersion = Math.max(historyVersion, event.historyVersion);
      seqs.push(event.seq);
    } else if (
      ((data.type === "message_updated" || data.type === "message_handled") &&
        messageIds.has(data.messageId)) ||
      ((data.type === "turn_completed" || data.type === "turn_failed") &&
        turnIds.has(data.turnId))
    ) {
      seqs.push(event.seq);
    }
  }
  if (!seqs.length) return;

  // Later rows keep the history version of the fork point. A later source
  // compaction is not copied, so its version must not become current.
  const e = juniorConversationEvents;
  await getSqlExecutor()
    .db()
    .execute(
      sql`insert into ${e} (${sql.join(
        [
          e.conversationId,
          e.seq,
          e.historyVersion,
          e.schemaVersion,
          e.idempotencyKey,
          e.type,
          e.payload,
          e.actorIdentityId,
          e.createdAt,
        ].map((column) => sql.identifier(column.name)),
        sql`, `,
      )})
      select ${args.conversationId}, ${e.seq}, least(${e.historyVersion}, ${historyVersion}), ${e.schemaVersion}, ${e.idempotencyKey}, ${e.type}, ${e.payload}, ${e.actorIdentityId}, ${e.createdAt}
      from ${e}
      where ${e.conversationId} = ${args.sourceConversationId}
        and ${inArray(e.seq, seqs)}`,
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
