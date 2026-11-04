import type { User } from "@sentry/junior-plugin-api";
import { and, inArray, isNull } from "drizzle-orm";
import {
  acceptsWebMessages,
  appendAndEnqueueWebMessage,
  webActorFromUser,
} from "@/chat/conversations/web-input";
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
import { formatUserInputAnswer } from "@/chat/tools/runtime/user-input-request";
import { juniorConversations } from "@/db/schema";
import type { ReviewItemChangeRecord } from "./change-record";
import type { ReviewItem } from "./store";

/** One change to a Review item that linked Conversations learn about. */
export type ReviewItemChange =
  | { kind: "submitted"; user: User }
  | { kind: "dismissed"; user: User }
  | { kind: "taken"; user: User }
  | { kind: "replied"; who: string }
  | { kind: "closed"; reason: string };

/**
 * Return the record that a message about a person change carries. A reply or
 * an agent close is not a person change, so it has no record.
 */
export function reviewItemChangeRecord(
  item: ReviewItem,
  change: ReviewItemChange,
): ReviewItemChangeRecord | undefined {
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
export function renderReviewItemMessage(
  item: ReviewItem,
  change: ReviewItemChange,
): string {
  const label = `review item "${item.title}" (${item.id})`;
  const question = item.request ? [`Question: ${item.request.question}`] : [];
  switch (change.kind) {
    case "submitted":
      return [
        `${personName(change.user)} answered ${label}. The item is done.`,
        "",
        item.request && item.answer
          ? formatUserInputAnswer(item.request, item.answer)
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
        `[review item]`,
        "",
        `${change.who} replied in a thread linked to ${label}, so the item closed as done. The reply went to that thread, not here, so it does not give user approval.`,
        ...question,
      ].join("\n");
    case "closed":
      return [
        `[review item]`,
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

function takeMessageId(item: ReviewItem, user: User): string {
  return `review-item:${item.id}:taken:${user.id}:${item.updatedAt.getTime()}`;
}

/**
 * Save a take as a handled Message in one Conversation. A take does not
 * start a Turn or reach the model: the agent has nothing to do until the
 * person answers. The dashboard shows the Message from its record. A retry
 * is safe, because the Message id is the take key.
 */
async function recordReviewItemTake(args: {
  conversationId: string;
  item: ReviewItem;
  nowMs: number;
  user: User;
}): Promise<void> {
  const change: ReviewItemChange = { kind: "taken", user: args.user };
  const messageId = takeMessageId(args.item, args.user);
  await getConversationEventStore().append(args.conversationId, [
    {
      idempotencyKey: `message:${messageId}`,
      createdAtMs: args.nowMs,
      data: {
        type: "message",
        messageId,
        role: "user",
        text: renderReviewItemMessage(args.item, change),
        meta: {
          author: {
            email: args.user.email,
            ...(args.user.displayName
              ? { fullName: args.user.displayName }
              : undefined),
          },
          replied: false,
          reviewItemChanges: [reviewItemChangeRecord(args.item, change)],
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
  change: ReviewItemChange;
  conversationId: string;
  item: ReviewItem;
  nowMs: number;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  if (args.change.kind === "taken") {
    await recordReviewItemTake({
      conversationId: args.conversationId,
      item: args.item,
      nowMs: args.nowMs,
      user: args.change.user,
    });
    return;
  }
  // Only the first close wins, so one close message per item is enough.
  const key = `review-item:${args.item.id}:closed`;
  const record = reviewItemChangeRecord(args.item, args.change);
  if ("user" in args.change) {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
    if (acceptsWebMessages(args.conversationId, conversation?.destination)) {
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
      eventType: `review_item.${args.change.kind}`,
      identifier: args.item.id,
      namespace: "junior",
      trustedSummary: `Review item "${args.item.title}" changed: ${args.change.kind}.`,
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
 * message starts a new Turn, except a take, which is only recorded. Repeat
 * calls for the same change are safe.
 */
export async function sendReviewItemMessages(args: {
  change: ReviewItemChange;
  exceptConversationId?: string;
  item: ReviewItem;
  nowMs: number;
  queue: ConversationWorkQueue;
}): Promise<void> {
  const conversationIds = (
    await openConversationIds(args.item.conversationIds)
  ).filter((id) => id !== args.exceptConversationId);
  const text = renderReviewItemMessage(args.item, args.change);
  const results = await Promise.allSettled(
    conversationIds.map((conversationId) =>
      sendOne({ ...args, conversationId, text }),
    ),
  );
  // Try every Conversation first, so one failure does not hide the change
  // from the others. A retry sends only the missing messages. The caller
  // reports the error; this log names each Conversation that missed it.
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn("review_item.message.failed", {
        "app.review_item.id": args.item.id,
        "app.review_item.change": args.change.kind,
        "gen_ai.conversation.id": conversationIds[index],
      });
    }
  });
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
