import { randomUUID } from "node:crypto";
import * as z from "zod";
import { enqueueChildWaitingToParent } from "@/chat/agent-invocations/result";
import { publishAgentUpdate } from "@/chat/conversations/watch-events";
import { getDb } from "@/chat/db";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { deliverInboxItemChange } from "@/chat/inbox-items/changes";
import {
  canAgentChangeInboxItem,
  RESERVED_INBOX_ITEM_KEY_PREFIXES,
  canReadInboxItem,
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
  InboxItemEvidence,
  InboxItemRequest,
} from "@/chat/inbox-items/evidence";
import {
  getOpenInboxItemByDedupeKey,
  insertInboxItem,
  ownerConversationId,
  updateInboxItemContent,
  type InboxItem,
  type InboxItemContent,
  type InboxItemVisibility,
} from "@/chat/inbox-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool, zodToolDefinition } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import {
  userInputRequestSchema,
  type UserInputRequest,
} from "@/chat/inbox-items/user-input-request";
import {
  assigneesSchema,
  bodySchema,
  conversationIdsSchema,
  itemResult,
  ownerLinks,
  readableItem,
  inboxItemDelivery,
  titleSchema,
  type InboxItemToolContext,
  type InboxItemToolServices,
} from "@/chat/inbox-items/tool-support";

const subjectSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "Stable id of the thing the item is about, such as a pull request URL. Search matches it exactly.",
      ),
    title: z.string().trim().min(1).max(200).nullable().optional(),
    url: z.string().url().max(2000).nullable().optional(),
  })
  .strict();

const evidenceSchema = z
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
          .describe("Link to the source, such as a chart or a log search."),
        conversation_id: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .nullable()
          .optional()
          .describe(
            "A Conversation that holds the evidence. Set this or `url`.",
          ),
        label: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("Short name of the source, such as `Checkout p95 chart`."),
        note: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\r\n]*$/, "Use one line.")
          .nullable()
          .optional()
          .describe("One line: what this source shows."),
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
 * the thread can then answer it.
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

function requireRequest(kind: InboxItem["kind"], hasRequest: boolean): void {
  if (kind === "action" && !hasRequest) {
    throw new ToolInputError("An action item needs a `request`.");
  }
  if (kind === "notice" && hasRequest) {
    throw new ToolInputError("A notice has no `request`. Use kind `action`.");
  }
}

function subjectInput(
  subject: z.output<typeof subjectSchema> | null | undefined,
) {
  if (!subject) return undefined;
  return {
    id: subject.id,
    ...(subject.title ? { title: subject.title } : undefined),
    ...(subject.url ? { url: subject.url } : undefined),
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
      dedupe_key: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .superRefine((key, context) => {
          const reserved = RESERVED_INBOX_ITEM_KEY_PREFIXES.find(({ prefix }) =>
            key.startsWith(prefix),
          );
          if (reserved) {
            context.addIssue({
              code: "custom",
              message: `A \`dedupe_key\` that starts with \`${reserved.prefix}\` belongs to ${reserved.owner}. ${reserved.instead}`,
            });
          }
        })
        .nullable()
        .optional()
        .describe(
          "Stable key for what the item is about, such as `fair-source:entry:acme`. If an open item has this key, the call updates that item instead of adding another. Use the same key on each run. Omit for a one-time question.",
        ),
      request: userInputRequestSchema
        .safeExtend({
          evidence: evidenceSchema
            .nullable()
            .optional()
            .describe(
              "Sources for the facts in the question. With a suggested answer, cite what supports it and what argues against it, such as a Conversation or chart that disagrees. Each entry has a `url` or a `conversation_id`.",
            ),
        })
        .nullable()
        .optional()
        .describe(
          "Required for an action item. Not allowed for a notice. Ask for related input in one item. Write the question so it stands alone: a person who sees only the card must understand it.",
        ),
      subject: subjectSchema.nullable().optional(),
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
 * Normalize the evidence input: each entry names exactly one source, and
 * null fields mean omitted.
 */
function evidenceInput(
  evidence: z.output<typeof evidenceSchema> | null | undefined,
): InboxItemEvidence[] {
  return (evidence ?? []).map((entry) => {
    if (Boolean(entry.url) === Boolean(entry.conversation_id)) {
      throw new ToolInputError(
        "Each `evidence` entry needs a `url` or a `conversation_id`, not both.",
      );
    }
    return {
      label: entry.label,
      ...(entry.url ? { url: entry.url } : undefined),
      ...(entry.conversation_id
        ? { conversationId: entry.conversation_id }
        : undefined),
      ...(entry.note ? { note: entry.note } : undefined),
    };
  });
}

/** Store the question with its normalized evidence, if it cites any. */
function requestInput(
  { evidence: _input, ...question }: UserInputRequest & { evidence?: unknown },
  evidence: InboxItemEvidence[],
): InboxItemRequest {
  return { ...question, ...(evidence.length > 0 ? { evidence } : undefined) };
}

/** Create the tool that adds an Inbox item or updates the open one. */
export function createAddInboxItemTool(
  context: InboxItemToolContext,
  services: InboxItemToolServices,
) {
  return zodTool({
    ...addInboxItemToolDefinition,
    execute: async (input, options) => {
      requireRequest(input.kind, Boolean(input.request));
      const evidence = evidenceInput(input.request?.evidence);
      const db = getDb();
      const scope = await readInboxItemAgentScope(context);
      // A retry of the same tool call keeps the same key, so it updates the
      // item that the first attempt added.
      const dedupeKey =
        input.dedupe_key ?? `ask:${options.toolCallId ?? randomUUID()}`;
      const existing = await getOpenInboxItemByDedupeKey(
        db,
        dedupeKey,
        scope.tenant,
      );
      if (
        existing &&
        (!canReadInboxItem(existing, scope.reader) ||
          !canAgentChangeInboxItem(existing, scope))
      ) {
        throw new ToolInputError(
          "Another open item uses this `dedupe_key`. Use a different key.",
        );
      }
      // An item from a private Conversation is private. It stays private.
      const visibility: InboxItemVisibility =
        scope.inPrivateConversation || existing?.visibility === "private"
          ? "private"
          : "public";
      const conversationIds = [
        ...new Set([
          context.conversationId,
          ...(existing?.conversationIds ?? []),
          ...(input.conversation_ids ?? []),
        ]),
      ];
      // A cited Conversation passes the same check as a link, so evidence
      // cannot show a Conversation that the item's readers may not see.
      await requireInboxItemLinks({
        allowedIds: new Set([
          context.conversationId,
          ...(existing?.conversationIds ?? []),
        ]),
        conversationIds: [
          ...new Set([
            ...conversationIds,
            ...evidence.flatMap((entry) =>
              entry.conversationId ? [entry.conversationId] : [],
            ),
          ]),
        ],
        scope,
        tenant: existing ? existing.tenant : scope.tenant,
        visibility,
      });
      const assignees = input.assignees
        ? await resolveAssignees(
            db,
            input.assignees,
            existing ? existing.tenant : scope.tenant,
            services.findMentionedUserId,
          )
        : existing
          ? {
              everyone: existing.assignedToEveryone,
              userIds: existing.assignees.map((assignee) => assignee.userId),
            }
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
        automationId: existing
          ? existing.automationId
          : scope.reader.automationId,
        conversationIds: [context.conversationId, ...ownerLinks(existing)],
        scope,
        visibility,
      });
      const content: InboxItemContent = {
        assignedToEveryone: assignees.everyone,
        assigneeUserIds: assignees.userIds,
        body: input.body,
        conversationIds,
        kind: input.kind,
        title: input.title,
        visibility,
        ...(input.request
          ? { request: requestInput(input.request, evidence) }
          : undefined),
        ...(input.subject
          ? { subject: subjectInput(input.subject) }
          : undefined),
      };
      // Write only the item that the checks above read, so a concurrent add
      // cannot make this call change another item.
      if (existing) {
        const updated = await updateInboxItemContent(db, {
          ...content,
          id: existing.id,
          nowMs: Date.now(),
          // The latest add in the Conversation that added the item has the
          // most context. A Turn of another Conversation would not match
          // the owner, so it keeps the stored Turn.
          ...(context.turnId &&
          ownerConversationId(existing) === context.conversationId
            ? { addedByTurnId: context.turnId }
            : undefined),
        });
        if (!updated) {
          throw new ToolInputError(
            `Inbox item ${existing.id} closed. Add the item again.`,
          );
        }
        const item = await readableItem(existing.id, scope);
        await deliverInboxItemChange({
          delivery: inboxItemDelivery(services),
          item,
          nowMs: Date.now(),
        });
        await publishWaiting(services, item);
        return { created: false, item: itemResult(item) };
      }
      const item = await insertInboxItem(db, {
        ...content,
        dedupeKey,
        owner: { id: context.conversationId, kind: "conversation" },
        ...(context.turnId ? { addedByTurnId: context.turnId } : undefined),
        nowMs: Date.now(),
        ...(scope.reader.automationId
          ? { automationId: scope.reader.automationId }
          : undefined),
        ...(scope.tenant ? { tenant: scope.tenant } : undefined),
      });
      if (!item) {
        throw new ToolInputError(
          "Another open item started to use this `dedupe_key`. Add the item again.",
        );
      }
      await deliverInboxItemChange({
        delivery: inboxItemDelivery(services),
        item,
        nowMs: Date.now(),
      });
      await publishWaiting(services, item);
      return { created: true, item: itemResult(item) };
    },
  });
}

/**
 * Report that the item's owner Conversation waits on a person when the item
 * is an action, also when an update makes a notice an action: to its Watches,
 * and to its parent agent, so the parent does not ask again. An update can
 * come from another Conversation, so the owner, not the caller, reports it.
 * The Event key is the item, so a later update of the same action does not
 * report it again.
 */
async function publishWaiting(
  services: InboxItemToolServices,
  item: Pick<InboxItem, "body" | "id" | "kind" | "owner" | "request">,
): Promise<void> {
  const conversationId = ownerConversationId(item);
  if (item.kind !== "action" || !conversationId) return;
  const text = item.request?.question ?? item.body;
  await enqueueChildWaitingToParent({
    conversationId,
    inboxItemId: item.id,
    queue: services.queue(),
    text,
  });
  await publishAgentUpdate(
    conversationId,
    { type: "waiting", inboxItemId: item.id },
    {
      queue: services.queue(),
      update: async () => ({ status: "waiting", text }),
    },
  );
}
