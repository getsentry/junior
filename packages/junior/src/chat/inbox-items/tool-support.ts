/** Shared input and result shapes of the Inbox item tools. */
import * as z from "zod";
import { getDb } from "@/chat/db";
import type {
  InboxItemDelivery,
  ShowInboxItem,
} from "@/chat/inbox-items/changes";
import {
  canReadInboxItem,
  type InboxItemAgentScope,
} from "@/chat/inbox-items/access";
import {
  EVERYONE_ASSIGNEE,
  type FindMentionedUserId,
} from "@/chat/inbox-items/assignees";
import type { InboxItemRequest } from "@/chat/inbox-items/evidence";
import {
  getInboxItem,
  ownerConversationId,
  type InboxItem,
} from "@/chat/inbox-items/store";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/** Deferred tool catalog source for the Inbox item tools after add. */
export const INBOX_TOOL_SOURCE = {
  id: "inbox",
  description: "Update and search Inbox items: work that needs a person.",
} as const;

/** Who can act on an Inbox item. */
export const assigneesSchema = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(20)
  .describe(
    "Who can act on the item. Each entry is `everyone`, an email, or a mention such as `<@U123>`. Everyone means any person who can see the item.",
  );

/** Conversations that an Inbox item links to. */
export const conversationIdsSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(10);

/** Title of an Inbox item. */
export const titleSchema = z.string().trim().min(1).max(200);
/** Body of an Inbox item. */
export const bodySchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .describe("Markdown details for the person.");

/** Runtime context that the Inbox item tools read. */
export type InboxItemToolContext = Pick<
  ToolRuntimeContext,
  "actorIsApp" | "conversationId" | "resolveActorIdentity" | "source" | "turnId"
>;

/** What app setup gives the Inbox item tools. */
export interface InboxItemToolServices {
  findMentionedUserId: FindMentionedUserId;
  /** Read only after a change, so tool setup does not create a queue. */
  queue: () => ConversationWorkQueue;
  show: ShowInboxItem;
}

/** Deliver an Inbox item change through the services of the tools. */
export function inboxItemDelivery(
  services: InboxItemToolServices,
): InboxItemDelivery {
  return { queue: services.queue(), show: services.show };
}

/** The owner Conversation of an item, as a list of Conversations to check. */
export function ownerLinks(item: InboxItem | undefined): string[] {
  const conversationId = item ? ownerConversationId(item) : undefined;
  return conversationId ? [conversationId] : [];
}

/** Read an Inbox item that the agent may read, or fail with a tool input error. */
export async function readableItem(
  id: string,
  scope: InboxItemAgentScope,
): Promise<InboxItem> {
  const item = await getInboxItem(getDb(), id);
  if (!item || !canReadInboxItem(item, scope.reader)) {
    throw new ToolInputError(
      `Inbox item ${id} is not found. Use searchInboxItems to find its id.`,
    );
  }
  return item;
}

/** Render one Inbox item for a tool result. */
export function itemResult(item: InboxItem) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    title: item.title,
    body: item.body,
    assignees: [
      ...(item.assignedToEveryone ? [EVERYONE_ASSIGNEE] : []),
      ...item.assignees.map((assignee) => assignee.email),
    ],
    conversation_ids: item.conversationIds,
    dedupe_key: item.dedupeKey,
    visibility: item.visibility,
    updated_at: item.updatedAt.toISOString(),
    ...(item.subject ? { subject: item.subject } : undefined),
    ...(item.automationId ? { automation_id: item.automationId } : undefined),
    ...(item.request ? { request: requestResult(item.request) } : undefined),
    ...(item.answer ? { answer: item.answer } : undefined),
    ...(item.closedAt
      ? {
          closed_at: item.closedAt.toISOString(),
          closed_by: item.closedBy?.email ?? "agent",
        }
      : undefined),
    ...(item.closeReason ? { close_reason: item.closeReason } : undefined),
  };
}

/** Show the stored question with the tool's snake_case evidence keys. */
function requestResult({ evidence, ...question }: InboxItemRequest) {
  return {
    ...question,
    ...(evidence
      ? {
          evidence: evidence.map(({ conversationId, ...entry }) => ({
            ...entry,
            ...(conversationId
              ? { conversation_id: conversationId }
              : undefined),
          })),
        }
      : undefined),
  };
}
