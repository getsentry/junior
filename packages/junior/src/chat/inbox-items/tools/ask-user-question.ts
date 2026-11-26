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
  itemResult,
  inboxItemDelivery,
  questionContent,
  questionsSchema,
  type InboxItemToolContext,
  type InboxItemToolServices,
} from "@/chat/inbox-items/tool-support";

// Unlike Claude Code's AskUserQuestion, the call returns before the person
// answers, so the result says that no answer exists yet. A model that reads
// a finished call as an answer invents one.
const ASKED_NEXT_STEP = `The questions were sent. There is no answer yet. The answer arrives in a later Turn as an \`<inbox-item-answer>\` with the item id; a dismiss comes as a note. Do not guess the answer. If your next step needs it, end the Turn now with \`${NO_REPLY_TOOL_NAME}\` and no text: the card is your reply. Otherwise, finish the work that does not need it, then end the Turn.`;

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

export const askUserQuestionToolDefinition = zodToolDefinition({
  description:
    "Ask a person one or more questions with choices. This is how you ask a person anything. The questions go in their Inbox and, in a Slack thread, show as a card. The person answers in a later Turn, not in this call. Returns the Inbox item and what to do until the answer comes.",
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      questions: questionsSchema,
      assignees: assigneesSchema
        .nullable()
        .optional()
        .describe(
          "Who is asked. Omit for the person in this Turn, else the Automation creator in an Automation run, else the people still subscribed to the Conversation.",
        ),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema,
});

/** Create the tool that asks a person questions in a new Inbox item. */
export function createAskUserQuestionTool(
  context: InboxItemToolContext,
  services: InboxItemToolServices,
) {
  return zodTool({
    ...askUserQuestionToolDefinition,
    execute: async (input, options) => {
      const content = questionContent(input.questions);
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
      const conversationIds = [context.conversationId];
      await requireInboxItemLinks({
        allowedIds: new Set(conversationIds),
        conversationIds,
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
          "Only people answer questions, and this one would have none: this Turn has no person, and no default assignee has a User. Set `assignees` to the person who should answer, or reply in text.",
        );
      }
      await requireInboxItemAssignees({
        assignees,
        automationId: scope.reader.automationId,
        conversationIds,
        scope,
        visibility,
      });
      // A Turn replays a call that committed before its result was saved.
      // Its question already has the item, so the replay goes on with it.
      const item =
        (await insertInboxItem(db, {
          assignedToEveryone: assignees.everyone,
          assigneeUserIds: assignees.userIds,
          body: content.body,
          conversationIds,
          kind: "action",
          subject,
          title: content.title,
          request: content.request,
          owner: { id: context.conversationId, kind: "conversation" },
          ...(context.turnId ? { addedByTurnId: context.turnId } : undefined),
          nowMs: Date.now(),
        })) ?? (await getOpenInboxItemBySubject(db, subject));
      if (!item) {
        throw new ToolInputError(
          "This tool call already asked its question. To change it, update its Inbox item by its id.",
        );
      }
      await deliverInboxItemChange({
        delivery: inboxItemDelivery(services),
        item,
        nowMs: Date.now(),
      });
      await publishWaiting(services, context.conversationId, item);
      return { item: itemResult(item), next_step: ASKED_NEXT_STEP };
    },
  });
}

/**
 * Report that the Conversation that asked waits on a person. The Event key
 * is the item, so it reports each item once.
 */
async function publishWaiting(
  services: InboxItemToolServices,
  conversationId: string,
  item: Pick<InboxItem, "body" | "id">,
): Promise<void> {
  await publishAgentUpdate(
    conversationId,
    { type: "waiting", inboxItemId: item.id },
    {
      queue: services.queue(),
      update: async () => ({
        status: "waiting",
        text: item.body,
      }),
    },
  );
}
