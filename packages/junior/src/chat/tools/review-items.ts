import type { User } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  readConversationAccessFromSql,
  type ProviderTenant,
} from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { sendReviewItemMessages } from "@/chat/review-items/messages";
import {
  conversationParticipantUserIds,
  EVERYONE_ASSIGNEE,
  resolveAssignee,
  resolveAssignees,
  type ResolvedAssignees,
} from "@/chat/review-items/assignees";
import {
  canReadReviewItem,
  closeReviewItem,
  getOpenReviewItemByDedupeKey,
  getReviewItem,
  isSameTenant,
  insertReviewItem,
  searchReviewItems,
  updateReviewItemContent,
  type ReviewItem,
  type ReviewItemContent,
  type ReviewItemReader,
  type ReviewItemStatus,
  type ReviewItemVisibility,
} from "@/chat/review-items/store";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { userInputRequestSchema } from "@/chat/tools/runtime/user-input-request";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

/** Deferred tool catalog source for Review items. */
export const REVIEW_DESK_TOOL_SOURCE = {
  id: "review-desk",
  description:
    "Add, update, and search Review items: work on the review desk that needs a person.",
} as const;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

const assigneesSchema = z
  .array(z.string().trim().min(1).max(320))
  .min(1)
  .max(20)
  .describe(
    "Who can act on the item. Each entry is `everyone`, an email, or a Slack mention such as `<@U123>`. Everyone means any person who can see the item.",
  );

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

const conversationIdsSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(10);

const titleSchema = z.string().trim().min(1).max(200);
const bodySchema = z
  .string()
  .trim()
  .min(1)
  .max(4000)
  .describe("Markdown details for the person.");

type ReviewItemToolContext = Pick<
  ToolRuntimeContext,
  "conversationId" | "resolveActorIdentity" | "source"
>;

interface ActorScope {
  /** Whether the current Conversation is not public. */
  inPrivateConversation: boolean;
  reader: ReviewItemReader;
  /** Provider tenant of the current Conversation. */
  tenant?: ProviderTenant;
  user?: User;
}

async function actorScope(context: ReviewItemToolContext): Promise<ActorScope> {
  const user = (await context.resolveActorIdentity?.())?.user;
  const automationId =
    context.source.kind === "scheduled_automation" ||
    context.source.kind === "event_automation"
      ? context.source.automationId
      : undefined;
  const current = (
    await readConversationAccessFromSql(getDb(), [context.conversationId], user)
  ).get(context.conversationId);
  const tenant = current?.tenant;
  return {
    inPrivateConversation: current?.visibility !== "public",
    reader: {
      conversationId: context.conversationId,
      ...(automationId ? { automationId } : undefined),
      ...(tenant ? { tenants: [tenant] } : undefined),
      ...(user ? { userId: user.id } : undefined),
    },
    ...(tenant ? { tenant } : undefined),
    ...(user ? { user } : undefined),
  };
}

/**
 * Whether the agent can change an item. A private item, and any item seen
 * from a private Conversation, can change only from the Conversation or
 * Automation that added it. This keeps private content in its Conversation.
 */
function canChange(item: ReviewItem, scope: ActorScope): boolean {
  if (!scope.inPrivateConversation && item.visibility === "public") {
    return true;
  }
  return (
    item.addedByConversationId === scope.reader.conversationId ||
    (scope.reader.automationId !== undefined &&
      item.automationId === scope.reader.automationId)
  );
}

/**
 * Check the Conversations to link. Every link must be in the tenant of the
 * item. The current Conversation and the links that the item already has
 * are always allowed. A private item gets no other links. A public item can
 * get other links only to public Conversations.
 */
async function requireLinks(args: {
  allowedIds: ReadonlySet<string>;
  conversationIds: readonly string[];
  scope: ActorScope;
  tenant: ProviderTenant | undefined;
  visibility: ReviewItemVisibility;
}): Promise<void> {
  const access = await readConversationAccessFromSql(
    getDb(),
    args.conversationIds,
    args.scope.user,
  );
  for (const conversationId of args.conversationIds) {
    const conversation = access.get(conversationId);
    if (!conversation || !isSameTenant(conversation.tenant, args.tenant)) {
      throw new ToolInputError(`Conversation ${conversationId} is not found.`);
    }
    if (args.allowedIds.has(conversationId)) continue;
    if (args.visibility === "private") {
      throw new ToolInputError(
        "A private item links only to the Conversation that added it.",
      );
    }
    if (conversation.visibility !== "public") {
      throw new ToolInputError(
        conversation.canViewPrivateContent
          ? `Conversation ${conversationId} is private. Only public Conversations can be linked.`
          : `Conversation ${conversationId} is not found.`,
      );
    }
  }
}

/**
 * Check who a private item can go to. It cannot go to Everyone. Each User
 * must be the current Actor or a person in one of the given Conversations:
 * the current one and, for an existing item, the one that added it.
 */
async function requireAssigneesAllowed(
  scope: ActorScope,
  conversationIds: readonly string[],
  visibility: ReviewItemVisibility,
  assignees: ResolvedAssignees,
): Promise<void> {
  if (visibility === "public") return;
  if (assignees.everyone) {
    throw new ToolInputError(
      "A private item cannot be assigned to Everyone. Assign Users instead.",
    );
  }
  const others = assignees.userIds.filter((id) => id !== scope.user?.id);
  const inConversation = new Set<string>();
  for (const conversationId of new Set(conversationIds)) {
    for (const id of await conversationParticipantUserIds(
      getDb(),
      conversationId,
      others,
    )) {
      inConversation.add(id);
    }
  }
  const outside = others.filter((id) => !inConversation.has(id));
  if (outside.length > 0) {
    throw new ToolInputError(
      "A private item can be assigned only to people in its Conversation.",
    );
  }
}

function requireRequest(kind: ReviewItem["kind"], hasRequest: boolean): void {
  if (kind === "action" && !hasRequest) {
    throw new ToolInputError("An action item needs a `request`.");
  }
  if (kind === "notice" && hasRequest) {
    throw new ToolInputError("A notice has no `request`. Use kind `action`.");
  }
}

async function readableItem(
  id: string,
  scope: ActorScope,
): Promise<ReviewItem> {
  const item = await getReviewItem(getDb(), id);
  if (!item || !canReadReviewItem(item, scope.reader)) {
    throw new ToolInputError(`Review item ${id} is not found.`);
  }
  return item;
}

/** Render one Review item for a tool result. */
function itemResult(item: ReviewItem) {
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
    ...(item.request ? { request: item.request } : undefined),
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

/** Create the tool that adds a Review item or updates the open one. */
export function createAddReviewItemTool(context: ReviewItemToolContext) {
  return zodTool({
    description:
      "Add an item to the review desk when work needs a person. A `notice` only tells them something. An `action` asks for an answer with a `request`: a question and 1-4 fields, the same shape as requestUserInput. The answer arrives later as a message from the person who answered, so do not wait for it. The current Conversation is always linked. If an open item has the same `dedupe_key`, this updates that item instead of adding another.",
    exposure: "deferred",
    source: REVIEW_DESK_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        kind: z.enum(["notice", "action"]),
        title: titleSchema,
        body: bodySchema,
        assignees: assigneesSchema,
        dedupe_key: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe(
            "Stable key for what the item is about, such as `fair-source:entry:acme`. Use the same key on each run.",
          ),
        request: userInputRequestSchema
          .nullable()
          .optional()
          .describe("Required for an action item. Not allowed for a notice."),
        subject: subjectSchema.nullable().optional(),
        conversation_ids: conversationIdsSchema
          .nullable()
          .optional()
          .describe("Other Conversations to link."),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async (input) => {
      requireRequest(input.kind, Boolean(input.request));
      const db = getDb();
      const scope = await actorScope(context);
      const existing = await getOpenReviewItemByDedupeKey(
        db,
        input.dedupe_key,
        scope.tenant,
      );
      if (
        existing &&
        (!canReadReviewItem(existing, scope.reader) ||
          !canChange(existing, scope))
      ) {
        throw new ToolInputError(
          "Another open item uses this `dedupe_key`. Use a different key.",
        );
      }
      // An item from a private Conversation is private. It stays private.
      const visibility: ReviewItemVisibility =
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
      await requireLinks({
        allowedIds: new Set([
          context.conversationId,
          ...(existing?.conversationIds ?? []),
        ]),
        conversationIds,
        scope,
        tenant: existing ? existing.tenant : scope.tenant,
        visibility,
      });
      const assignees = await resolveAssignees(
        db,
        input.assignees,
        existing ? existing.tenant : scope.tenant,
      );
      await requireAssigneesAllowed(
        scope,
        existing
          ? [context.conversationId, existing.addedByConversationId]
          : [context.conversationId],
        visibility,
        assignees,
      );
      const content: ReviewItemContent = {
        assignedToEveryone: assignees.everyone,
        assigneeUserIds: assignees.userIds,
        body: input.body,
        conversationIds,
        kind: input.kind,
        title: input.title,
        visibility,
        ...(input.request ? { request: input.request } : undefined),
        ...(input.subject
          ? { subject: subjectInput(input.subject) }
          : undefined),
      };
      // Write only the item that the checks above read, so a concurrent add
      // cannot make this call change another item.
      if (existing) {
        const updated = await updateReviewItemContent(db, {
          ...content,
          id: existing.id,
          nowMs: Date.now(),
        });
        if (!updated) {
          throw new ToolInputError(
            `Review item ${existing.id} closed. Add the item again.`,
          );
        }
        return {
          created: false,
          item: itemResult(await readableItem(existing.id, scope)),
        };
      }
      const item = await insertReviewItem(db, {
        ...content,
        addedByConversationId: context.conversationId,
        dedupeKey: input.dedupe_key,
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
      return { created: true, item: itemResult(item) };
    },
  });
}

/**
 * Create the tool that changes or closes a Review item. A close tells the
 * other linked Conversations through `queue`.
 */
export function createUpdateReviewItemTool(
  context: ReviewItemToolContext,
  queue: () => ConversationWorkQueue,
) {
  return zodTool({
    description:
      "Change an open review desk item, or close it. Set `status` to `done` or `dismissed` with a `reason`, for example when its pull request merged. An item never closes on its own. You cannot submit the answer to an action item: only an assignee can.",
    exposure: "deferred",
    source: REVIEW_DESK_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    inputSchema: z
      .object({
        id: z.string().trim().min(1),
        title: titleSchema.nullable().optional(),
        body: bodySchema.nullable().optional(),
        assignees: assigneesSchema
          .nullable()
          .optional()
          .describe("Replaces every assignee."),
        conversation_ids: conversationIdsSchema
          .nullable()
          .optional()
          .describe(
            "Replaces every linked Conversation. An action item needs at least one.",
          ),
        status: z.enum(["done", "dismissed"]).nullable().optional(),
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
    execute: async (input) => {
      const db = getDb();
      const scope = await actorScope(context);
      const item = await readableItem(input.id, scope);
      if (item.status !== "open") {
        throw new ToolInputError(`Review item ${item.id} is already closed.`);
      }
      if (!canChange(item, scope)) {
        throw new ToolInputError(
          "Only the Conversation or Automation that added this item can change it.",
        );
      }
      if (input.status && !input.reason) {
        throw new ToolInputError("Give a `reason` when you close an item.");
      }
      const changesContent =
        input.title || input.body || input.assignees || input.conversation_ids;
      if (changesContent) {
        const conversationIds = input.conversation_ids ?? item.conversationIds;
        if (item.kind === "action" && conversationIds.length === 0) {
          throw new ToolInputError(
            "An action item needs at least one linked Conversation.",
          );
        }
        // This tool never changes visibility.
        const visibility = item.visibility;
        await requireLinks({
          allowedIds: new Set([
            context.conversationId,
            ...item.conversationIds,
          ]),
          conversationIds,
          scope,
          tenant: item.tenant,
          visibility,
        });
        const assignees = input.assignees
          ? await resolveAssignees(db, input.assignees, item.tenant)
          : {
              everyone: item.assignedToEveryone,
              userIds: item.assignees.map((assignee) => assignee.userId),
            };
        if (input.assignees) {
          await requireAssigneesAllowed(
            scope,
            [context.conversationId, item.addedByConversationId],
            visibility,
            assignees,
          );
        }
        const updated = await updateReviewItemContent(db, {
          assignedToEveryone: assignees.everyone,
          assigneeUserIds: assignees.userIds,
          body: input.body ?? item.body,
          conversationIds,
          id: item.id,
          kind: item.kind,
          nowMs: Date.now(),
          title: input.title ?? item.title,
          visibility,
          ...(item.request ? { request: item.request } : undefined),
          ...(item.subject ? { subject: item.subject } : undefined),
        });
        if (!updated) {
          throw new ToolInputError(`Review item ${item.id} is already closed.`);
        }
      }
      if (input.status && input.reason) {
        const nowMs = Date.now();
        const closed = await closeReviewItem(db, {
          id: item.id,
          nowMs,
          reason: input.reason,
          status: input.status,
        });
        if (!closed) {
          throw new ToolInputError(`Review item ${item.id} is already closed.`);
        }
        const closedItem = await readableItem(item.id, scope);
        await sendReviewItemMessages({
          change: { kind: "closed", reason: input.reason },
          exceptConversationId: context.conversationId,
          item: closedItem,
          nowMs,
          queue: queue(),
        });
        return { item: itemResult(closedItem) };
      }
      return { item: itemResult(await readableItem(item.id, scope)) };
    },
  });
}

/** Create the tool that searches Review items. */
export function createSearchReviewItemsTool(context: ReviewItemToolContext) {
  return zodTool({
    description:
      "Search review desk items that you can see, newest change first. For example, find the open items for one pull request before you add or close one.",
    exposure: "deferred",
    source: REVIEW_DESK_TOOL_SOURCE,
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: z
      .object({
        subject_id: z.string().trim().min(1).max(500).nullable().optional(),
        status: z
          .enum(["open", "done", "dismissed", "any"])
          .nullable()
          .optional()
          .describe("Default `open`."),
        assignee: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .nullable()
          .optional()
          .describe("`everyone`, an email, or a Slack mention."),
        automation_id: z.string().trim().min(1).nullable().optional(),
        conversation_id: z.string().trim().min(1).nullable().optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .nullable()
          .optional()
          .describe(`Default ${DEFAULT_LIMIT}; max ${MAX_LIMIT}.`),
      })
      .strict(),
    outputSchema: juniorToolOutputSchema,
    execute: async (input) => {
      const db = getDb();
      const scope = await actorScope(context);
      const status = input.status ?? "open";
      const statuses: ReviewItemStatus[] =
        status === "any" ? ["open", "done", "dismissed"] : [status];
      const items = await searchReviewItems(db, scope.reader, {
        limit: input.limit ?? DEFAULT_LIMIT,
        statuses,
        ...(input.assignee
          ? {
              assignee: await resolveAssignee(db, input.assignee, scope.tenant),
            }
          : undefined),
        ...(input.automation_id
          ? { automationId: input.automation_id }
          : undefined),
        ...(input.conversation_id
          ? { conversationId: input.conversation_id }
          : undefined),
        ...(input.subject_id ? { subjectId: input.subject_id } : undefined),
      });
      return { count: items.length, items: items.map(itemResult) };
    },
  });
}
