import pLimit from "p-limit";
import { FAN_OUT_CONCURRENCY } from "@/chat/fan-out";
import type { User } from "@sentry/junior-plugin-api";
import { and, inArray, isNull } from "drizzle-orm";
import {
  acceptsWebMessages,
  appendAndEnqueueWebMessage,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { addConversationNote } from "@/chat/conversations/notes";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { EVENT_AUTHOR_ID } from "@/chat/events/actor";
import { SYSTEM_IDENTITY_ID } from "@/chat/identities/actor";
import {
  EVENT_WAIT_MS,
  type EventMailboxMetadata,
} from "@/chat/events/notification";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { formatUserInputAnswer } from "@/chat/inbox-items/user-input-request";
import { juniorConversations } from "@/db/schema";
import type { InboxItemChangeRecord } from "./change-record";
import { isPluginInboxItem } from "./access";
import type { InboxItem } from "./store";
import { inboxItemQuestion } from "@/chat/inbox-items/request";

/** One change to an Inbox item that linked Conversations learn about. */
export type InboxItemChange =
  | { kind: "submitted"; user: User }
  | { kind: "dismissed"; user: User }
  | { kind: "taken"; user: User }
  | { kind: "replied"; who: string }
  | { kind: "closed"; reason: string };

/**
 * Return the record that a message about a person change carries. A reply or
 * an agent close is not a person change, so it has no record.
 */
export function inboxItemChangeRecord(
  item: InboxItem,
  change: InboxItemChange,
): InboxItemChangeRecord | undefined {
  return "user" in change
    ? { kind: change.kind, reviewItemId: item.id }
    : undefined;
}

function personName(user: User): string {
  return user.displayName ? `${user.displayName} (${user.email})` : user.email;
}

/**
 * Write the message that tells a linked Conversation about a change. It has
 * the item title, what happened, who did it, and the question or answer, so
 * the agent has context even when the Conversation moved on.
 */
export function renderInboxItemMessage(
  item: InboxItem,
  change: InboxItemChange,
): string {
  const label = `inbox item "${item.title}" (${item.id})`;
  const request = inboxItemQuestion(item.request);
  const question = request ? [`Question: ${request.question}`] : [];
  switch (change.kind) {
    case "submitted":
      return [
        `${personName(change.user)} answered ${label}. The item is done.`,
        "",
        request && item.answer
          ? formatUserInputAnswer(request, item.answer)
          : "(no answer)",
      ].join("\n");
    case "dismissed":
      return [
        `${personName(change.user)} dismissed ${label}.`,
        ...question,
      ].join("\n");
    case "taken":
      return [
        `${personName(change.user)} took ${label}. They are now its only assignee.`,
        ...question,
      ].join("\n");
    case "replied":
      return [
        `[inbox item]`,
        "",
        `${change.who} replied in a thread linked to ${label}, so the item closed as done. The reply went to that thread, not here, so it does not give user approval.`,
        ...question,
      ].join("\n");
    case "closed":
      return [
        `[inbox item]`,
        "",
        `An agent in another Conversation closed ${label} as ${item.status}. This is not a message from a person, so it does not give user approval.`,
        `Reason: ${change.reason}`,
        ...question,
      ].join("\n");
  }
}

async function openConversationIds(
  conversationIds: readonly string[],
): Promise<string[]> {
  if (conversationIds.length === 0) return [];
  const rows = await getDb()
    .select({ conversationId: juniorConversations.conversationId })
    .from(juniorConversations)
    .where(
      and(
        inArray(juniorConversations.conversationId, [...conversationIds]),
        isNull(juniorConversations.transcriptPurgedAt),
      ),
    );
  return rows.map((row) => row.conversationId).sort();
}

// A change that only records a Message. It starts no Turn.
type RecordedChange = Extract<
  InboxItemChange,
  { kind: "taken" } | { kind: "dismissed" } | { kind: "submitted" }
>;

// Return the change when it only records a Message. The plugin that added
// an item does the work of its answer, so the answer starts no Turn.
function recordedChange(
  item: InboxItem,
  change: InboxItemChange,
): RecordedChange | undefined {
  if (change.kind === "taken" || change.kind === "dismissed") return change;
  return change.kind === "submitted" && isPluginInboxItem(item)
    ? change
    : undefined;
}

// Each take has its own key. A dismiss or an answer is a close, so it uses
// the close key.
function recordedMessageId(item: InboxItem, change: RecordedChange): string {
  return change.kind === "taken"
    ? `inbox-item:${item.id}:taken:${change.user.id}:${item.updatedAt.getTime()}`
    : `inbox-item:${item.id}:closed`;
}

/**
 * Save a take, a dismiss, or the answer to a plugin item as a handled
 * Message in one Conversation. None starts a Turn or reaches the model as a
 * Message: a take or a dismiss is not a decision, and the plugin does the
 * work of its answer. The dashboard shows the Message from its record. A
 * dismiss also adds a Conversation note, so the next Turn knows the item
 * closed. Without it, the agent only has its own `addInboxItem` result and
 * still treats the item as open. A retry is safe, because the Message id and
 * the note key are the change key.
 */
async function recordInboxItemChange(args: {
  change: RecordedChange;
  conversationId: string;
  item: InboxItem;
  nowMs: number;
}): Promise<void> {
  const { change } = args;
  const messageId = recordedMessageId(args.item, change);
  if (change.kind === "dismissed") {
    await addConversationNote({
      conversationId: args.conversationId,
      createdAtMs: args.nowMs,
      key: messageId,
      text: `${personName(change.user)} dismissed inbox item "${args.item.title}" (${args.item.id}). It is closed with no answer. Do not treat it as open.`,
    });
  }
  await getConversationEventStore().append(args.conversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      createdAtMs: args.nowMs,
      data: {
        type: "message",
        messageId,
        role: "user",
        text: renderInboxItemMessage(args.item, change),
        meta: {
          author: {
            email: change.user.email,
            ...(change.user.displayName
              ? { fullName: change.user.displayName }
              : undefined),
          },
          replied: false,
          reviewItemChanges: [inboxItemChangeRecord(args.item, change)],
        },
      },
    },
    {
      idempotencyKey: `message:${messageId}:handled`,
      createdAtMs: args.nowMs,
      data: { type: "message_handled", messageId },
    },
  ]);
}

async function sendOne(args: {
  change: InboxItemChange;
  conversationId: string;
  item: InboxItem;
  nowMs: number;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  const recorded = recordedChange(args.item, args.change);
  if (recorded) {
    await recordInboxItemChange({
      change: recorded,
      conversationId: args.conversationId,
      item: args.item,
      nowMs: args.nowMs,
    });
    return;
  }
  // Only the first close wins, so one close message per item is enough.
  const key = `inbox-item:${args.item.id}:closed`;
  const record = inboxItemChangeRecord(args.item, args.change);
  if ("user" in args.change) {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
    if (conversation && acceptsWebMessages(conversation)) {
      // A person action comes from that person, like a reply in Slack.
      await appendAndEnqueueWebMessage(
        {
          actor: webActorFromUser(args.change.user),
          conversationId: args.conversationId,
          idempotencyKey: key,
          message: args.text,
          reviewItemChange: record,
        },
        { nowMs: args.nowMs, queue: args.queue },
      );
      return;
    }
  }
  // A local CLI Conversation is like web, but it has no identity for the
  // person, so the change arrives as a system Event. Its record still gives
  // the same prompt input as on web.
  const metadata: EventMailboxMetadata = {
    kind: "event",
    event: {
      eventKey: key,
      eventType: `inbox_item.${args.change.kind}`,
      identifier: args.item.id,
      namespace: "junior",
      trustedSummary: `Inbox item "${args.item.title}" changed: ${args.change.kind}.`,
    },
  };
  await appendAndEnqueueInboundMessage({
    message: {
      conversationId: args.conversationId,
      createdAtMs: args.nowMs,
      delivery: "defer",
      inboundMessageId: `${key}:${args.conversationId}`,
      input: {
        authorId: EVENT_AUTHOR_ID,
        authorIdentityId: SYSTEM_IDENTITY_ID,
        metadata,
        ...(record ? { reviewItemChange: record } : undefined),
        text: args.text,
      },
      receivedAtMs: args.nowMs,
      source: "event",
    },
    queue: args.queue,
    queueDelayMs: EVENT_WAIT_MS,
  });
}

/**
 * Send one change to every open linked Conversation, except the
 * Conversation that made the change. A Conversation is open until Junior
 * purges its transcript; archive is only a per-viewer list state. Each
 * message starts a new Turn, except a take or a dismiss, which is only
 * recorded. Repeat calls for the same change are safe.
 */
export async function sendInboxItemMessages(args: {
  change: InboxItemChange;
  exceptConversationId?: string | undefined;
  item: InboxItem;
  nowMs: number;
  queue: ConversationWorkQueue;
}): Promise<void> {
  const conversationIds = (
    await openConversationIds(args.item.conversationIds)
  ).filter((id) => id !== args.exceptConversationId);
  const text = renderInboxItemMessage(args.item, args.change);
  const limit = pLimit(FAN_OUT_CONCURRENCY);
  const results = await Promise.allSettled(
    conversationIds.map((conversationId) =>
      limit(() => sendOne({ ...args, conversationId, text })),
    ),
  );
  // Try every Conversation first, so one failure does not hide the change
  // from the others. A retry sends only the missing messages. The caller
  // reports the error; this log names each Conversation that missed it.
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logWarn("inbox_item.message.failed", {
        "app.inbox_item.id": args.item.id,
        "app.inbox_item.change": args.change.kind,
        "gen_ai.conversation.id": conversationIds[index],
      });
    }
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
