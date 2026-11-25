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
import type {
  InboxItemNoticeRequest,
  InboxItemRelatedLink,
  InboxItemRequest,
} from "@/chat/inbox-items/request";
import {
  userInputFieldsSchema,
  userInputQuestionSchema,
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/inbox-items/user-input-request";
import { parseToolInput } from "@/chat/tool-support/zod-tool";
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
    visibility: item.visibility,
    updated_at: item.updatedAt.toISOString(),
    subject: item.subject,
    ...(item.addedByAutomationId
      ? { automation_id: item.addedByAutomationId }
      : undefined),
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

/** Show the stored question with the tool's snake_case related link keys. */
function requestResult({
  related,
  ...question
}: InboxItemRequest | InboxItemNoticeRequest) {
  return {
    ...question,
    ...(related
      ? {
          related: related.map(({ conversationId, ...entry }) => ({
            ...entry,
            ...(conversationId
              ? { conversation_id: conversationId }
              : undefined),
          })),
        }
      : undefined),
  };
}

const relatedSchema = z
  .array(
    z
      .object({
        url: z
          .string()
          .url()
          .max(2000)
          .refine(
            // `url()` also accepts `javascript:` and `data:` URLs.
            (url) =>
              URL.canParse(url) &&
              ["http:", "https:"].includes(new URL(url).protocol),
            "Use an http(s) URL.",
          )
          .nullable()
          .optional()
          .describe(
            "A link, such as a chart, a log search, or the pull request that the item is about. The card shows these links.",
          ),
        conversation_id: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .nullable()
          .optional()
          .describe("A related Conversation. Set this or `url`."),
        label: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("Short name of the link, such as `Checkout p95 chart`."),
        note: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]*$/, "Use one line.")
          .nullable()
          .optional()
          .describe("One line: what this link shows."),
      })
      .strict(),
  )
  .max(10);

const questionRequestSchema = z.object({
  request: userInputRequestSchema,
});

/**
 * Return the question of an action. An action needs one. A notice asks
 * nothing, so its `request` may hold only related links.
 */
export function questionInput(
  kind: InboxItem["kind"],
  request: z.output<typeof requestInputSchema> | null | undefined,
): UserInputRequest | undefined {
  if (kind === "notice") {
    if (request?.question || request?.fields) {
      throw new ToolInputError(
        "A notice asks nothing, so its `request` holds only `related`. To ask, use kind `action`.",
      );
    }
    return undefined;
  }
  if (!request?.question || !request.fields) {
    throw new ToolInputError(
      "An action item needs a `request` with a `question` and `fields`.",
    );
  }
  const { related: _related, ...question } = request;
  return parseToolInput(questionRequestSchema, { request: question }).request;
}

/** The `request` param of the Inbox item tools that ask or change a question. */
export const requestInputSchema = z.object({
  question: userInputQuestionSchema
    .optional()
    .describe(
      "The question, in markdown. Include the facts the person needs to decide. Required for an action. Not allowed for a notice.",
    ),
  fields: userInputFieldsSchema
    .optional()
    .describe(
      "What to ask, in display order. Use one `choice` field for a simple decision. Required for an action. Not allowed for a notice.",
    ),
  related: relatedSchema
    .nullable()
    .optional()
    .describe(
      "Links related to the item: what it is about, such as a pull request, and the sources for its facts. With a suggested answer, link what supports it and what argues against it. Each entry has a `url` or a `conversation_id`.",
    ),
});

/**
 * Normalize the related links: each entry names exactly one link, null
 * fields mean omitted, and a link is stored as `URL.href`, so it matches
 * the link of the work that it names.
 */
export function relatedInput(
  related: z.output<typeof relatedSchema> | null | undefined,
): InboxItemRelatedLink[] {
  return (related ?? []).map((entry) => {
    if (Boolean(entry.url) === Boolean(entry.conversation_id)) {
      throw new ToolInputError(
        "Each `related` entry needs a `url` or a `conversation_id`, not both.",
      );
    }
    return {
      label: entry.label,
      ...(entry.url ? { url: new URL(entry.url).href } : undefined),
      ...(entry.conversation_id
        ? { conversationId: entry.conversation_id }
        : undefined),
      ...(entry.note ? { note: entry.note } : undefined),
    };
  });
}

/**
 * Store the question with its normalized related links, if it has any. A
 * notice stores only its related links.
 */
export function requestInput(
  question: UserInputRequest | undefined,
  related: InboxItemRelatedLink[],
): InboxItemRequest | InboxItemNoticeRequest | undefined {
  if (!question) return related.length > 0 ? { related } : undefined;
  return { ...question, ...(related.length > 0 ? { related } : undefined) };
}
