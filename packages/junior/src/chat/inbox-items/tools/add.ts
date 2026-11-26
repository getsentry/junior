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
import {
  getOpenInboxItemBySubject,
  insertInboxItem,
  type InboxItem,
  type InboxItemVisibility,
} from "@/chat/inbox-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import {
  assigneesSchema,
  bodySchema,
  conversationIdsSchema,
  itemResult,
  inboxItemDelivery,
  questionInput,
  relatedInput,
  requestInput,
  requestInputSchema,
  titleSchema,
  type InboxItemToolContext,
  type InboxItemToolServices,
} from "@/chat/inbox-items/tool-support";
import { inboxItemQuestion } from "@/chat/inbox-items/request";

/**
 * Pick the assignees of a new item when the agent names none: the User of
 * the Actor, or else the creator of the Automation of this run. A Turn with
 * a system Actor, such as an event Turn, or an app Actor falls back to the
 * active Participants of the Conversation, except the app. A Slack Actor
 * without a Junior User gets an item with no assignees, so that the agent can
 * still ask; any person in the thread can then answer it on its card.
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
  if (scope.actorIsPerson) return { everyone: false, userIds: [] };
  const participants = await activeParticipantUserIds(getDb(), conversationId);
  return {
    everyone: false,
    userIds: participants.filter((id) => id !== scope.appUserId),
  };
}

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
      // The item is as private as the Conversation that asks it.
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
      // without a person, such as one that an app asked for, has nobody to
      // show it to, so it needs an assignee.
      if (
        !assignees.everyone &&
        assignees.userIds.length === 0 &&
        !scope.actorIsPerson
      ) {
        throw new ToolInputError(
          "Only people act on items, and this one would have none: this Turn has no person, and no default assignee has a User. Set `assignees` to the person who should act, or reply in text.",
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
      // A Turn replays a call that committed before its result was saved.
      // Its question already has the item, so the replay goes on with it.
      const item =
        (await insertInboxItem(db, {
          assignedToEveryone: assignees.everyone,
          assigneeUserIds: assignees.userIds,
          body: input.body,
          conversationIds,
          kind: input.kind,
          subject,
          title: input.title,
          ...(request ? { request } : undefined),
          owner: { id: context.conversationId, kind: "conversation" },
          ...(context.turnId ? { addedByTurnId: context.turnId } : undefined),
          nowMs: Date.now(),
        })) ?? (await getOpenInboxItemBySubject(db, subject));
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
