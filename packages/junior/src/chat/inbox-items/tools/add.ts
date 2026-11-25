import { randomUUID } from "node:crypto";
import * as z from "zod";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getDb } from "@/chat/db";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { deliverInboxItemChange } from "@/chat/inbox-items/changes";
import {
  questionSubject,
  readInboxItemAgentScope,
  requireInboxItemAssignees,
  requireInboxItemLinks,
  type InboxItemAgentScope,
} from "@/chat/inbox-items/access";
import {
  activeParticipantUserIds,
  automationCreatorUserId,
  resolveAssignees,
  type ResolvedAssignees,
} from "@/chat/inbox-items/assignees";
import type {
  InboxItemRelatedLink,
  InboxItemNoticeRequest,
  InboxItemRequest,
} from "@/chat/inbox-items/request";
import {
  insertInboxItem,
  type InboxItem,
  type InboxItemVisibility,
} from "@/chat/inbox-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import {
  parseToolInput,
  zodTool,
  zodToolDefinition,
} from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import {
  userInputFieldsSchema,
  userInputQuestionSchema,
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/inbox-items/user-input-request";
import {
  assigneesSchema,
  bodySchema,
  conversationIdsSchema,
  itemResult,
  inboxItemDelivery,
  titleSchema,
  type InboxItemToolContext,
  type InboxItemToolServices,
} from "@/chat/inbox-items/tool-support";
import { inboxItemQuestion } from "@/chat/inbox-items/request";

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

/**
 * Pick the assignees of a new item when the agent names none: the User of
 * the Actor, or else the creator of the Automation of this run. A Turn with
 * a system Actor, such as an event Turn, falls back to the active
 * Participants of the Conversation. A Slack Actor without a Junior User gets
 * an item with no assignees, so that the agent can still ask; any person in
 * the thread can then answer it on its card.
 */
async function defaultAssignees(
  scope: InboxItemAgentScope,
  conversationId: string,
): Promise<ResolvedAssignees> {
  const userId =
    scope.user?.id ??
    (scope.reader.automationId
      ? await automationCreatorUserId(getDb(), scope.reader.automationId)
      : undefined);
  if (userId) return { everyone: false, userIds: [userId] };
  return {
    everyone: false,
    userIds: scope.actorIsPerson
      ? []
      : await activeParticipantUserIds(getDb(), conversationId),
  };
}

const questionRequestSchema = z.object({
  request: userInputRequestSchema,
});

/**
 * Return the question of an action. An action needs one. A notice asks
 * nothing, so its `request` may hold only related links.
 */
function questionInput(
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

const requestInputSchema = z.object({
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

export const addInboxItemToolDefinition = zodToolDefinition({
  description: `Ask a person for input, or tell them about work that needs them. This is how you ask a person anything: the item goes in the Inbox and, in a Slack thread, shows as a card with buttons. The answer arrives later as a \`<inbox-item-answer>\` with the item id. A dismiss comes as a note. An assignee's thread reply that answers the item also closes it. If your next step needs the answer, end the Turn now with \`${NO_REPLY_TOOL_NAME}\` and no text: the card is your reply. Continue other work that does not need the answer.`,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      kind: z
        .enum(["notice", "action"])
        .describe(
          "Use `action` with a `request` to ask. Use `notice` only to tell a person something.",
        ),
      title: titleSchema,
      body: bodySchema,
      assignees: assigneesSchema
        .nullable()
        .optional()
        .describe(
          "Who can act on the item. Omit for the person in this Turn, else the Automation creator in an Automation run, else the people still subscribed to the Conversation.",
        ),
      request: requestInputSchema
        .nullable()
        .optional()
        .describe(
          "Required for an action item. A notice may have one with only `related`. Ask for related input in one item. Write the question so it stands alone: a person who sees only the card must understand it.",
        ),
      conversation_ids: conversationIdsSchema
        .nullable()
        .optional()
        .describe(
          "Other Conversations to link. The current Conversation is always linked.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema,
});

/**
 * Normalize the related links: each entry names exactly one link, null
 * fields mean omitted, and a link is stored as `URL.href`, so it matches
 * the link of the work that it names.
 */
function relatedInput(
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
function requestInput(
  question: UserInputRequest | undefined,
  related: InboxItemRelatedLink[],
): InboxItemRequest | InboxItemNoticeRequest | undefined {
  if (!question) return related.length > 0 ? { related } : undefined;
  return { ...question, ...(related.length > 0 ? { related } : undefined) };
}

/** Create the tool that adds an Inbox item that asks a new question. */
export function createAddInboxItemTool(
  context: InboxItemToolContext,
  services: InboxItemToolServices,
) {
  return zodTool({
    ...addInboxItemToolDefinition,
    execute: async (input, options) => {
      const question = questionInput(input.kind, input.request);
      const related = relatedInput(input.request?.related);
      const db = getDb();
      const scope = await readInboxItemAgentScope(context);
      // Each call asks a new question. A retry of the same tool call keeps
      // the same question id, so it cannot add a second item.
      const subject = questionSubject(
        `ask:${options.toolCallId ?? randomUUID()}`,
      );
      // An item from a private Conversation is private.
      const visibility: InboxItemVisibility = scope.inPrivateConversation
        ? "private"
        : "public";
      const conversationIds = [
        ...new Set([context.conversationId, ...(input.conversation_ids ?? [])]),
      ];
      // A related Conversation passes the same check as a linked one, so
      // the card cannot show a Conversation that the item's readers may not see.
      await requireInboxItemLinks({
        allowedIds: new Set([context.conversationId]),
        conversationIds: [
          ...new Set([
            ...conversationIds,
            ...related.flatMap((entry) =>
              entry.conversationId ? [entry.conversationId] : [],
            ),
          ]),
        ],
        scope,
        tenant: scope.tenant,
        visibility,
      });
      const assignees = input.assignees
        ? await resolveAssignees(
            db,
            input.assignees,
            scope.tenant,
            services.findMentionedUserId,
          )
        : await defaultAssignees(scope, context.conversationId);
      // Only an assignee gets the item in their Inbox count. A Turn
      // without a person has nobody to show it to, so it needs an assignee.
      if (
        !assignees.everyone &&
        assignees.userIds.length === 0 &&
        !scope.actorIsPerson
      ) {
        throw new ToolInputError(
          "No person would see this item: no default assignee has a User, and this Turn has no person. Set `assignees`.",
        );
      }
      await requireInboxItemAssignees({
        assignees,
        automationId: scope.reader.automationId,
        conversationIds: [context.conversationId],
        scope,
        visibility,
      });
      const request = requestInput(question, related);
      const item = await insertInboxItem(db, {
        assignedToEveryone: assignees.everyone,
        assigneeUserIds: assignees.userIds,
        body: input.body,
        conversationIds,
        kind: input.kind,
        subject,
        title: input.title,
        visibility,
        ...(request ? { request } : undefined),
        owner: { id: context.conversationId, kind: "conversation" },
        ...(context.turnId ? { addedByTurnId: context.turnId } : undefined),
        nowMs: Date.now(),
        ...(scope.tenant ? { tenant: scope.tenant } : undefined),
      });
      if (!item) {
        throw new ToolInputError(
          "This tool call already added its item. To change it, update it by its id.",
        );
      }
      await deliverInboxItemChange({
        delivery: inboxItemDelivery(services),
        item,
        nowMs: Date.now(),
      });
      await publishWaiting(services, context.conversationId, item);
      return { item: itemResult(item) };
    },
  });
}

/**
 * Report that the Conversation that asked waits on a person when the item
 * is an action. The Event key is the item, so it reports each item once.
 */
async function publishWaiting(
  services: InboxItemToolServices,
  conversationId: string,
  item: Pick<InboxItem, "body" | "id" | "kind" | "request">,
): Promise<void> {
  if (item.kind !== "action") return;
  await publishAgentUpdate(
    conversationId,
    { type: "waiting", inboxItemId: item.id },
    {
      queue: services.queue(),
      update: async () => ({
        status: "waiting",
        text: inboxItemQuestion(item.request)?.question ?? item.body,
      }),
    },
  );
}
