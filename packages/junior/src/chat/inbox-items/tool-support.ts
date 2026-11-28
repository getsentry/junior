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
import {
  inboxItemRequestSchema,
  type InboxItemNoticeRequest,
  type InboxItemRequest,
} from "@/chat/inbox-items/request";
import {
  USER_INPUT_LIMITS,
  type UserInputField,
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

/** Deferred tool catalog source for the Inbox item tools. */
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
          closed_by:
            (item.answer ? item.answeredBy : item.closedBy)?.email ?? "agent",
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

const RECOMMENDED_SUFFIX = /\s*\(recommended\)$/i;
// The Inbox row shows the title, so it stays short.
const MAX_TITLE_CHARS = 200;

const questionOptionSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxLabelChars)
      .describe(
        "The choice the person picks, 1-5 words. The answer uses this text.",
      ),
    description: z
      .string()
      .trim()
      .min(1)
      .max(USER_INPUT_LIMITS.maxDescriptionChars)
      .describe("What this choice means or what happens if it is picked."),
  })
  .strict();

/**
 * The questions of `askUserQuestion` and `updateInboxItem`. The keys are
 * the ones of Claude Code's `AskUserQuestion`, which models know, so they
 * are camelCase where it is (`multiSelect`).
 */
export const questionsSchema = z
  .array(
    z
      .object({
        question: z
          .string()
          .trim()
          .min(1)
          .max(USER_INPUT_LIMITS.maxFieldDescriptionChars)
          .describe(
            "The complete question, clear and specific, ending with a question mark.",
          ),
        header: z
          .string()
          .trim()
          .min(1)
          .max(12)
          .describe(
            "A very short label for the question, max 12 characters, such as `Approach`.",
          ),
        options: z
          .array(questionOptionSchema)
          .min(USER_INPUT_LIMITS.minOptions)
          .max(4)
          .describe(
            'The 2-4 choices. Put the recommended one first and end its label with "(Recommended)". Do not add an "Other" choice: the person can always write their own answer.',
          ),
        multiSelect: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "True lets the person pick more than one choice. Default false.",
          ),
      })
      .strict(),
  )
  .min(1)
  .max(USER_INPUT_LIMITS.maxFields)
  .describe(
    "The questions to ask, 1-4. Ask each decision as its own question, with its own choices, not several decisions in one question.",
  );

/** The stored content of the questions that an agent asks. */
export interface QuestionContent {
  body: string;
  request: InboxItemRequest;
  title: string;
}

/** Cut text to the length of an item title, as a question's title is cut. */
export function cutInboxItemTitle(text: string): string {
  return text.length <= MAX_TITLE_CHARS
    ? text
    : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

/**
 * Store each question as one field with its own question, header, and
 * choices, and no question that the fields share, so every surface shows
 * each question with its own answer. A label that ends with
 * "(Recommended)" becomes a recommended choice.
 */
export function questionContent(
  questions: z.output<typeof questionsSchema>,
): QuestionContent {
  const fields: UserInputField[] = questions.map((entry, index) => ({
    id: `q${index + 1}`,
    label: entry.header,
    description: entry.question,
    kind: entry.multiSelect ? "multi_choice" : "choice",
    options: entry.options.map((option) => {
      const label = option.label.replace(RECOMMENDED_SUFFIX, "").trim();
      return {
        label: label || option.label,
        description: option.description,
        ...(label && label !== option.label
          ? { recommended: true }
          : undefined),
      };
    }),
  }));
  const request = parseToolInput(inboxItemRequestSchema, { fields });
  return {
    body: questions.map((entry) => entry.question).join("\n\n"),
    request,
    title: cutInboxItemTitle(
      questions.length === 1
        ? questions[0]!.question
        : questions.map((entry) => entry.header).join(" · "),
    ),
  };
}
