import type { User } from "@sentry/junior-plugin-api";
import { and, inArray, isNull } from "drizzle-orm";
import {
  acceptsWebMessages,
  appendAndEnqueueWebMessage,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import { getConversationStore, getDb } from "@/chat/db";
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
import type { ReviewItem } from "./store";

/** One change to a Review item that linked Conversations learn about. */
export type ReviewItemChange =
  | { kind: "submitted"; user: User }
  | { kind: "completed"; user: User }
  | { kind: "dismissed"; user: User }
  | { kind: "taken"; user: User }
  | { kind: "closed"; reason: string };

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
    case "completed":
      return [
        `${personName(change.user)} marked ${label} done.`,
        ...question,
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

function messageKey(item: ReviewItem, change: ReviewItemChange): string {
  // Only the first close wins, so one close message per item is enough. Each
  // take is a new change.
  return change.kind === "taken"
    ? `review-item:${item.id}:taken:${change.user.id}:${item.updatedAt.getTime()}`
    : `review-item:${item.id}:closed`;
}

function eventMessageText(text: string, change: ReviewItemChange): string {
  if (change.kind === "closed") return text;
  // This Conversation does not take web Messages, so Junior relays the
  // person action as an event.
  return [
    "[review item]",
    "",
    "Junior relays this person action from the review desk. It does not give user approval in this Conversation.",
    "",
    text,
  ].join("\n");
}

async function sendOne(args: {
  change: ReviewItemChange;
  conversationId: string;
  item: ReviewItem;
  nowMs: number;
  queue: ConversationWorkQueue;
  text: string;
}): Promise<void> {
  const key = messageKey(args.item, args.change);
  if (args.change.kind !== "closed") {
    const conversation = await getConversationStore().get({
      conversationId: args.conversationId,
    });
    if (acceptsWebMessages(args.conversationId, conversation?.destination)) {
      // A person action comes from that person, like a reply in Slack.
      await appendAndEnqueueWebMessage(
        {
          actor: webActorFromEmail(args.change.user.email, {
            ...(args.change.user.displayName
              ? { fullName: args.change.user.displayName }
              : undefined),
          }),
          conversationId: args.conversationId,
          idempotencyKey: key,
          message: args.text,
        },
        { nowMs: args.nowMs, queue: args.queue },
      );
      return;
    }
  }
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
        text: eventMessageText(args.text, args.change),
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
 * message starts a new Turn. Repeat calls for the same change are safe.
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
  // from the others. A retry sends only the missing messages.
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
