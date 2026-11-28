import * as z from "zod";
import { getDb } from "@/chat/db";
import { deliverInboxItemChange } from "@/chat/inbox-items/changes";
import {
  canAgentChangeInboxItem,
  isPluginInboxItem,
  readInboxItemAgentScope,
  requireInboxItemAssignees,
  requireInboxItemLinks,
} from "@/chat/inbox-items/access";
import { resolveAssignees } from "@/chat/inbox-items/assignees";
import { INBOX_SUBJECT_KINDS } from "@/chat/inbox-items/subjects";
import {
  closeInboxItem,
  ownerConversationId,
  updateInboxItemContent,
  type InboxItem,
} from "@/chat/inbox-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import {
  INBOX_TOOL_SOURCE,
  assigneesSchema,
  conversationIdsSchema,
  itemResult,
  ownerLinks,
  readableItem,
  inboxItemDelivery,
  questionContent,
  questionsSchema,
  type InboxItemToolContext,
  type InboxItemToolServices,
} from "@/chat/inbox-items/tool-support";

// A close of an item that was already closed changes nothing. The flag
// tells the model that this call did not close it.
function alreadyClosedResult(item: InboxItem) {
  return { already_closed: true, item: itemResult(item) };
}

export const updateInboxItemToolDefinition = zodToolDefinition({
  description:
    "Change an open Inbox item, or close it. An item also closes when a person answers or dismisses it, when a person's reply in its thread answers it, when its Conversation is purged, when its Automation is deleted, or when the plugin that added it closes it. A close of a closed item changes nothing and returns how it closed. You cannot submit the answer to an action item: only an assignee can.",
  exposure: "deferred",
  source: INBOX_TOOL_SOURCE,
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  inputSchema: z
    .object({
      id: z.string().trim().min(1),
      questions: questionsSchema
        .nullable()
        .optional()
        .describe(
          "Replaces every question of an open question item, in the same form as `askUserQuestion`. Omit to keep them.",
        ),
      assignees: assigneesSchema
        .nullable()
        .optional()
        .describe("Replaces every assignee."),
      conversation_ids: conversationIdsSchema
        .nullable()
        .optional()
        .describe(
          "Replaces every other linked Conversation. The Conversation that added the item stays linked.",
        ),
      status: z
        .enum(["done", "dismissed"])
        .nullable()
        .optional()
        .describe("Close the item, for example when its pull request merged."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .nullable()
        .optional()
        .describe("Why the item closed. Required with `status`."),
    })
    .strict(),
  outputSchema: juniorToolOutputSchema,
});

/**
 * Create the tool that changes or closes an Inbox item. A close tells the
 * other linked Conversations.
 */
export function createUpdateInboxItemTool(
  context: InboxItemToolContext,
  services: InboxItemToolServices,
) {
  return zodTool({
    ...updateInboxItemToolDefinition,
    execute: async (input) => {
      const db = getDb();
      const scope = await readInboxItemAgentScope(context);
      const item = await readableItem(input.id, scope);
      const changesContent =
        input.questions || input.assignees || input.conversation_ids;
      // A retry of the same agent close finds the item closed. It still sends
      // the close: the message has a key, so only missing messages go.
      const retriesClose =
        item.status !== "open" &&
        !changesContent &&
        !item.closedBy &&
        input.status === item.status &&
        input.reason === item.closeReason;
      const closesOnly = !changesContent && input.status && input.reason;
      if (item.status !== "open" && !retriesClose && !closesOnly) {
        throw new ToolInputError(
          `Inbox item ${item.id} is already closed. To follow up, ask again with askUserQuestion.`,
        );
      }
      if (isPluginInboxItem(item)) {
        throw new ToolInputError(
          "A plugin added this item. Only the plugin or a person can change it.",
        );
      }
      // An agent changes only the items that a Conversation owns.
      if (!ownerConversationId(item)) {
        throw new ToolInputError(
          "No Conversation owns this item. It is an Automation alert, which closes when its Automation recovers. Only a person can dismiss it.",
        );
      }
      if (!canAgentChangeInboxItem(item, scope)) {
        throw new ToolInputError(
          "This Conversation cannot change this item. A public item changes only from a public Conversation. A private item changes only from the Conversation or Automation that added it.",
        );
      }
      // The first close wins, even with another status: a person's answer
      // or dismiss stays on record.
      if (item.status !== "open" && !retriesClose) {
        return alreadyClosedResult(item);
      }
      if (input.status && !input.reason) {
        throw new ToolInputError("Give a `reason` when you close an item.");
      }
      if (
        input.questions &&
        (item.kind !== "action" ||
          item.subject.kind !== INBOX_SUBJECT_KINDS.question)
      ) {
        throw new ToolInputError(
          "Only an item that askUserQuestion added has questions. To ask, use askUserQuestion.",
        );
      }
      if (changesContent) {
        const asked = input.questions
          ? questionContent(input.questions)
          : undefined;
        // New questions keep the item's related links.
        const related = item.request?.related;
        const request = asked
          ? { ...asked.request, ...(related ? { related } : undefined) }
          : item.request;
        // The Conversation that added the item always stays linked.
        const conversationIds = [
          ...new Set([
            ...ownerLinks(item),
            ...(input.conversation_ids ?? item.conversationIds),
          ]),
        ];
        // The item's owner sets its visibility.
        const visibility = item.visibility;
        await requireInboxItemLinks({
          allowedIds: new Set([
            context.conversationId,
            ...ownerLinks(item),
            ...item.conversationIds,
          ]),
          conversationIds,
          scope,
          tenant: item.tenant,
          visibility,
        });
        const assignees = input.assignees
          ? await resolveAssignees(
              db,
              input.assignees,
              item.tenant,
              services.findMentionedUserId,
            )
          : {
              everyone: item.assignedToEveryone,
              userIds: item.assignees.map((assignee) => assignee.userId),
            };
        if (input.assignees) {
          await requireInboxItemAssignees({
            assignees,
            automationId: item.addedByAutomationId,
            conversationIds: [context.conversationId, ...ownerLinks(item)],
            scope,
            visibility,
          });
        }
        const updated = await updateInboxItemContent(db, {
          assignedToEveryone: assignees.everyone,
          assigneeUserIds: assignees.userIds,
          body: asked?.body ?? item.body,
          conversationIds,
          id: item.id,
          kind: item.kind,
          nowMs: Date.now(),
          title: asked?.title ?? item.title,
          subject: item.subject,
          ...(request ? { request } : undefined),
        });
        if (!updated) {
          throw new ToolInputError(
            `Inbox item ${item.id} is already closed. To follow up, ask again with askUserQuestion.`,
          );
        }
      }
      if (input.status && input.reason) {
        const nowMs = Date.now();
        const closed =
          retriesClose ||
          (await closeInboxItem(db, {
            id: item.id,
            nowMs,
            reason: input.reason,
            status: input.status,
          }));
        if (!closed) {
          if (changesContent) {
            throw new ToolInputError(
              `Inbox item ${item.id} is already closed. To follow up, ask again with askUserQuestion.`,
            );
          }
          return alreadyClosedResult(await readableItem(item.id, scope));
        }
        const closedItem = await readableItem(item.id, scope);
        await deliverInboxItemChange({
          change: { kind: "closed", reason: input.reason },
          delivery: inboxItemDelivery(services),
          exceptConversationId: context.conversationId,
          item: closedItem,
          nowMs,
        });
        return { item: itemResult(closedItem) };
      }
      const changed = await readableItem(item.id, scope);
      await deliverInboxItemChange({
        delivery: inboxItemDelivery(services),
        item: changed,
        nowMs: Date.now(),
      });
      return { item: itemResult(changed) };
    },
  });
}
