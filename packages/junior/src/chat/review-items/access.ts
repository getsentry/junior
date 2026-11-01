import type { User } from "@sentry/junior-plugin-api";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import {
  readConversationAccessFromSql,
  type ProviderTenant,
} from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  juniorReviewItemAssignees,
  juniorReviewItemConversations,
  juniorReviewItems,
} from "@/db/schema";
import {
  automationCreatorUserId,
  conversationParticipantUserIds,
  type ResolvedAssignees,
} from "./assignees";
import type { ReviewItem, ReviewItemVisibility } from "./store";

// Every Review item access rule lives in this file. See "Access" in
// AGENTS.md for the product rules that each function applies.

/**
 * Who reads Review items. An item is visible when it is public and its
 * tenant is one of the reader's tenants, when the reader is an assigned
 * User, or when it is linked to the reader's Conversation or added by the
 * reader's Automation.
 */
export interface ReviewItemReader {
  automationId?: string;
  conversationId?: string;
  /** Provider tenants where the reader can see public items. */
  tenants?: readonly ProviderTenant[];
  userId?: string;
}

/** Return whether two tenants are the same. Two missing tenants match. */
function isSameTenant(
  a: ProviderTenant | undefined,
  b: ProviderTenant | undefined,
): boolean {
  return (
    a?.provider === b?.provider && a?.providerTenantId === b?.providerTenantId
  );
}

/**
 * The reader for one person: items assigned to them, and public items in the
 * provider tenants of their identities.
 */
export function reviewItemReaderForUser(user: User): ReviewItemReader {
  return {
    tenants: user.identities.flatMap((identity) =>
      identity.providerTenantId
        ? [
            {
              provider: identity.provider,
              providerTenantId: identity.providerTenantId,
            },
          ]
        : [],
    ),
    userId: user.id,
  };
}

/** SQL: the Review item has this assigned User. */
export function reviewItemAssignedTo(userId: string): SQL {
  return sql`exists (select 1 from ${juniorReviewItemAssignees} where ${juniorReviewItemAssignees.itemId} = ${juniorReviewItems.id} and ${juniorReviewItemAssignees.userId} = ${userId})`;
}

/**
 * SQL: the Review item needs this User. Only an open `action` item that is
 * assigned to the User needs them. A notice, an item for Everyone, and an
 * item without assignees need no one. An assigned User can always see the
 * item, so this rule needs no visibility check. The nav count and the
 * "Waiting on you" marker use this rule.
 */
export function reviewItemNeedsUser(userId: string): SQL {
  return and(
    eq(juniorReviewItems.status, "open"),
    eq(juniorReviewItems.kind, "action"),
    reviewItemAssignedTo(userId),
  )!;
}

/** SQL: the Review item links this Conversation. */
export function reviewItemLinkedTo(conversationId: string): SQL {
  return sql`exists (select 1 from ${juniorReviewItemConversations} where ${juniorReviewItemConversations.itemId} = ${juniorReviewItems.id} and ${juniorReviewItemConversations.conversationId} = ${conversationId})`;
}

function publicIn(tenants: readonly ProviderTenant[]): SQL[] {
  return tenants.map(
    (tenant) =>
      and(
        eq(juniorReviewItems.visibility, "public"),
        eq(juniorReviewItems.provider, tenant.provider),
        eq(juniorReviewItems.providerTenantId, tenant.providerTenantId),
      )!,
  );
}

/**
 * SQL form of `canReadReviewItem`, for search. Keep the two the same; the
 * Review item access test checks that they agree.
 */
export function reviewItemVisibleTo(reader: ReviewItemReader): SQL {
  // `or` of nothing is undefined, so `false` keeps the query closed.
  return or(
    sql`false`,
    ...publicIn(reader.tenants ?? []),
    ...(reader.userId ? [reviewItemAssignedTo(reader.userId)] : []),
    ...(reader.conversationId
      ? [reviewItemLinkedTo(reader.conversationId)]
      : []),
    ...(reader.automationId
      ? [eq(juniorReviewItems.automationId, reader.automationId)]
      : []),
  )!;
}

/** Return whether a reader can see one Review item. */
export function canReadReviewItem(
  item: ReviewItem,
  reader: ReviewItemReader,
): boolean {
  return (
    (item.visibility === "public" &&
      item.tenant !== undefined &&
      (reader.tenants ?? []).some((tenant) =>
        isSameTenant(tenant, item.tenant),
      )) ||
    (reader.userId !== undefined &&
      item.assignees.some((assignee) => assignee.userId === reader.userId)) ||
    (reader.conversationId !== undefined &&
      item.conversationIds.includes(reader.conversationId)) ||
    (reader.automationId !== undefined &&
      item.automationId === reader.automationId)
  );
}

/** What an agent can see and change, from the Conversation it runs in. */
export interface ReviewItemAgentScope {
  /** Whether the current Conversation is not public. */
  inPrivateConversation: boolean;
  reader: ReviewItemReader;
  /** Provider tenant of the current Conversation. */
  tenant?: ProviderTenant;
  user?: User;
}

/**
 * Read the scope of an agent. The agent reads as its Conversation and
 * Automation, not as its Actor: an assignment lets a person see the item on
 * the review desk, not let an agent read it into another Conversation.
 */
export async function readReviewItemAgentScope(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "resolveActorIdentity" | "source"
  >,
): Promise<ReviewItemAgentScope> {
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
    },
    ...(tenant ? { tenant } : undefined),
    ...(user ? { user } : undefined),
  };
}

/**
 * Dedupe keys with this prefix belong to plugins. Only the plugin that added
 * the item, or a person, can change it. An agent cannot use the prefix.
 */
export const PLUGIN_REVIEW_ITEM_KEY_PREFIX = "plugin:";

/**
 * Whether an agent can change an item. Only an agent in the tenant of the
 * item can change it. A public item changes only from a public
 * Conversation, so private content never reaches its readers. A private
 * item changes only from the Conversation or Automation that added it. An
 * agent never changes an item that a plugin added.
 */
export function canAgentChangeReviewItem(
  item: ReviewItem,
  scope: ReviewItemAgentScope,
): boolean {
  if (item.dedupeKey.startsWith(PLUGIN_REVIEW_ITEM_KEY_PREFIX)) return false;
  if (!isSameTenant(item.tenant, scope.tenant)) return false;
  if (item.visibility === "public") return !scope.inPrivateConversation;
  return (
    item.addedByConversationId === scope.reader.conversationId ||
    (scope.reader.automationId !== undefined &&
      item.automationId === scope.reader.automationId)
  );
}

/**
 * Check the Conversations that an agent links. Every link must be in the
 * tenant of the item. `allowedIds` (the current Conversation and the links
 * that the item already has) always pass. A private item gets no other
 * links. A public item can get other links only to public Conversations.
 */
export async function requireReviewItemLinks(args: {
  allowedIds: ReadonlySet<string>;
  conversationIds: readonly string[];
  scope: ReviewItemAgentScope;
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
 * Check who an agent assigns a private item to. It cannot go to Everyone.
 * Each User must be the current Actor, a person in one of the given
 * Conversations (the current one and, for an existing item, the one that
 * added it), or the creator of the Automation that added the item. An
 * Automation run often has no Actor and no people yet, and its creator wrote
 * the work. A public item can go to anyone.
 */
export async function requireReviewItemAssignees(args: {
  assignees: ResolvedAssignees;
  automationId: string | undefined;
  conversationIds: readonly string[];
  scope: ReviewItemAgentScope;
  visibility: ReviewItemVisibility;
}): Promise<void> {
  if (args.visibility === "public") return;
  if (args.assignees.everyone) {
    throw new ToolInputError(
      "A private item cannot be assigned to Everyone. Assign Users instead.",
    );
  }
  const creatorId = args.automationId
    ? await automationCreatorUserId(getDb(), args.automationId)
    : undefined;
  const others = args.assignees.userIds.filter(
    (id) => id !== args.scope.user?.id && id !== creatorId,
  );
  const inConversation = new Set<string>();
  for (const conversationId of new Set(args.conversationIds)) {
    for (const id of await conversationParticipantUserIds(
      getDb(),
      conversationId,
      others,
    )) {
      inConversation.add(id);
    }
  }
  if (others.some((id) => !inConversation.has(id))) {
    throw new ToolInputError(
      "A private item can be assigned only to people in its Conversation.",
    );
  }
}

/**
 * Return whether a User can act on an open Review item: an assigned User,
 * anyone for an item assigned to Everyone, and anyone for an item with no
 * assignees. The caller checks that the User can see the item.
 */
export function canActOnReviewItem(item: ReviewItem, userId: string): boolean {
  if (item.status !== "open") return false;
  if (item.assignedToEveryone) return true;
  if (item.assignees.length === 0) return true;
  return item.assignees.some((assignee) => assignee.userId === userId);
}

/** Return whether a User is already the only assignee, so take does nothing. */
export function isOnlyAssignee(item: ReviewItem, userId: string): boolean {
  return (
    !item.assignedToEveryone &&
    item.assignees.length === 1 &&
    item.assignees[0]?.userId === userId
  );
}
