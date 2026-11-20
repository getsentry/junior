/** Shared input and result shapes of the Review item tools. */
import * as z from "zod";
import { getDb } from "@/chat/db";
import type {
  ReviewItemDelivery,
  ShowReviewItem,
} from "@/chat/review-items/changes";
import {
  canReadReviewItem,
  type ReviewItemAgentScope,
} from "@/chat/review-items/access";
import {
  EVERYONE_ASSIGNEE,
  type FindMentionedUserId,
} from "@/chat/review-items/assignees";
import type { ReviewItemRequest } from "@/chat/review-items/evidence";
import { getReviewItem, type ReviewItem } from "@/chat/review-items/store";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/** Deferred tool catalog source for the Review item tools after add. */
export const INBOX_TOOL_SOURCE = {
  id: "inbox",
  description:
    "Update and search Review items: work in the Inbox that needs a person.",
} as const;

/** Who can act on a Review item. */
export const assigneesSchema = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(20)
  .describe(
    "Who can act on the item. Each entry is `everyone`, an email, or a mention such as `<@U123>`. Everyone means any person who can see the item.",
  );

/** Conversations that a Review item links to. */
export const conversationIdsSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(10);

/** Title of a Review item. */
export const titleSchema = z.string().trim().min(1).max(200);
/** Body of a Review item. */
export const bodySchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .describe("Markdown details for the person.");

/** Runtime context that the Review item tools read. */
export type ReviewItemToolContext = Pick<
  ToolRuntimeContext,
  "conversationId" | "resolveActorIdentity" | "source" | "turnId"
>;

/** What app setup gives the Review item tools. */
export interface ReviewItemToolServices {
  findMentionedUserId: FindMentionedUserId;
  /** Read only after a change, so tool setup does not create a queue. */
  queue: () => ConversationWorkQueue;
  show: ShowReviewItem;
}

/** Deliver a Review item change through the services of the tools. */
export function reviewItemDelivery(
  services: ReviewItemToolServices,
): ReviewItemDelivery {
  return { queue: services.queue(), show: services.show };
}

/** Read a Review item that the agent may read, or fail with a tool input error. */
export async function readableItem(
  id: string,
  scope: ReviewItemAgentScope,
): Promise<ReviewItem> {
  const item = await getReviewItem(getDb(), id);
  if (!item || !canReadReviewItem(item, scope.reader)) {
    throw new ToolInputError(`Review item ${id} is not found.`);
  }
  return item;
}

/** Render one Review item for a tool result. */
export function itemResult(item: ReviewItem) {
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
function requestResult({ evidence, ...question }: ReviewItemRequest) {
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
