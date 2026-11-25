import type { User } from "@sentry/junior-plugin-api";
import {
  and,
  eq,
  exists,
  isNotNull,
  isNull,
  notLike,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  readConversationAccessFromSql,
  type ProviderTenant,
} from "@/api/conversations/access";
import { getDb } from "@/chat/db";
import { UPDATE_TODOS_TOOL_NAME } from "@/chat/todos/types";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorInboxItemAssignees,
  juniorInboxItemConversations,
  juniorInboxItems,
} from "@/db/schema";
import {
  automationCreatorUserId,
  conversationParticipantUserIds,
  type ResolvedAssignees,
} from "./assignees";
import type { InboxItem, InboxItemVisibility } from "./store";

// Every Inbox item access rule lives in this file. Callers must not copy a
// rule.

/**
 * Who reads Inbox items. An item is visible when it is public and its
 * tenant is one of the reader's tenants, when the reader is an assigned
 * User, when it is linked to the reader's Conversation or added by the
 * reader's Automation, or when it is a public question linked to the public
 * Conversation that the reader views.
 */
export interface InboxItemReader {
  automationId?: string;
  conversationId?: string;
  /**
   * A public Conversation that a person views but does not take part in.
   * Only its public questions (`action` items) are visible: a private item
   * stays private when its Conversation becomes public, and a notice is for
   * its assignees.
   */
  publicConversationId?: string;
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
export function inboxItemReaderForUser(user: User): InboxItemReader {
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

/**
 * SQL: a Conversation owns the Inbox item. The Conversation status and
 * feeds read the items that each Conversation owns.
 */
export function inboxItemOwnedByConversation(
  conversationId: SQL | AnyColumn | string,
): SQL {
  return and(
    eq(juniorInboxItems.ownerKind, "conversation"),
    eq(juniorInboxItems.ownerId, conversationId),
  )!;
}

const todoOwner = alias(juniorConversations, "todo_owner");
const todoRoot = alias(juniorConversations, "todo_root");

/** SQL: the User is a Participant of this root Conversation. */
function participantOf(userId: string, rootConversationId: AnyColumn): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(juniorConversationParticipants)
      .where(
        and(
          eq(
            juniorConversationParticipants.rootConversationId,
            rootConversationId,
          ),
          eq(juniorConversationParticipants.userId, userId),
        ),
      ),
  );
}

/**
 * SQL: the User can see the private content of the Conversation that owns
 * the item. This is the rule of `conversationAccessFromRows`: the User is a
 * Participant of the owner when it has no parent, even with no stored root.
 * Otherwise the owner needs a valid stored root, whose Destination is public
 * or whose Participants include the User.
 */
function ownerConversationOpenTo(userId: string): SQL {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(todoOwner)
      .leftJoin(
        todoRoot,
        and(
          eq(todoRoot.conversationId, todoOwner.rootConversationId),
          eq(todoRoot.rootConversationId, todoRoot.conversationId),
          isNull(todoRoot.parentConversationId),
          or(
            isNotNull(todoOwner.parentConversationId),
            eq(todoOwner.rootConversationId, todoOwner.conversationId),
          ),
        ),
      )
      .where(
        and(
          eq(todoOwner.conversationId, juniorInboxItems.ownerId),
          or(
            and(
              isNull(todoOwner.parentConversationId),
              participantOf(userId, todoOwner.conversationId),
            ),
            and(
              isNotNull(todoRoot.conversationId),
              or(
                eq(todoRoot.visibility, "public"),
                participantOf(userId, todoRoot.conversationId),
              ),
            ),
          ),
        ),
      ),
  );
}

/**
 * SQL: the Inbox item has this assigned User. A To-do's item counts only
 * while the User can see its Conversation's private content, so a person
 * who loses access to the Conversation no longer sees or acts on it.
 */
export function inboxItemAssignedTo(userId: string): SQL {
  return and(
    sql`exists (select 1 from ${juniorInboxItemAssignees} where ${juniorInboxItemAssignees.itemId} = ${juniorInboxItems.id} and ${juniorInboxItemAssignees.userId} = ${userId})`,
    or(
      notLike(juniorInboxItems.dedupeKey, `${TODO_INBOX_ITEM_KEY_PREFIX}%`),
      ownerConversationOpenTo(userId),
    ),
  )!;
}

/**
 * SQL: the Inbox item needs this User. Only an open `action` item that is
 * assigned to the User needs them. A notice, an item for Everyone, and an
 * item without assignees need no one. An assigned User can see the item
 * (`inboxItemAssignedTo`), so this rule needs no other visibility check. The nav count and the
 * "Waiting on you" marker use this rule.
 */
export function inboxItemNeedsUser(userId: string): SQL {
  return and(
    eq(juniorInboxItems.status, "open"),
    eq(juniorInboxItems.kind, "action"),
    inboxItemAssignedTo(userId),
  )!;
}

/**
 * SQL: the Inbox item waits for a person's input: an open `action` item,
 * whoever it is assigned to. An item with no assignees still waits for
 * anyone who can answer it. The Conversation that added it shows
 * `needs_input`. `junior_inbox_items_open_action_added_by_idx` has this
 * predicate.
 */
export function inboxItemNeedsInput(): SQL {
  return and(
    eq(juniorInboxItems.status, "open"),
    eq(juniorInboxItems.kind, "action"),
  )!;
}

/**
 * SQL: the Inbox item is not assigned only to other people. It is assigned
 * to this User, to Everyone, or to no one. This is the assignee rule of
 * `canActOnInboxItem`; keep the two the same.
 */
export function inboxItemForUser(userId: string): SQL {
  return or(
    eq(juniorInboxItems.assignedToEveryone, true),
    sql`not exists (select 1 from ${juniorInboxItemAssignees} where ${juniorInboxItemAssignees.itemId} = ${juniorInboxItems.id})`,
    inboxItemAssignedTo(userId),
  )!;
}

/** SQL: the Inbox item links this Conversation. */
export function inboxItemLinkedTo(conversationId: string): SQL {
  return sql`exists (select 1 from ${juniorInboxItemConversations} where ${juniorInboxItemConversations.itemId} = ${juniorInboxItems.id} and ${juniorInboxItemConversations.conversationId} = ${conversationId})`;
}

function publicIn(tenants: readonly ProviderTenant[]): SQL[] {
  return tenants.map((tenant) =>
    and(
      eq(juniorInboxItems.visibility, "public"),
      eq(juniorInboxItems.provider, tenant.provider),
      eq(juniorInboxItems.providerTenantId, tenant.providerTenantId),
    )!,
  );
}

/**
 * SQL form of `canReadInboxItem`, for search. Keep the two the same; the
 * Inbox item access test checks that they agree.
 */
export function inboxItemVisibleTo(reader: InboxItemReader): SQL {
  // `or` of nothing is undefined, so `false` keeps the query closed. Do not
  // put `false` inside the `or`: Postgres then cannot turn a lone assignee
  // `exists` into a semi-join, and it scans every closed item.
  return (
    or(
      ...publicIn(reader.tenants ?? []),
      ...(reader.userId ? [inboxItemAssignedTo(reader.userId)] : []),
      ...(reader.conversationId
        ? [inboxItemLinkedTo(reader.conversationId)]
        : []),
      ...(reader.publicConversationId
        ? [
            and(
              eq(juniorInboxItems.visibility, "public"),
              eq(juniorInboxItems.kind, "action"),
              inboxItemLinkedTo(reader.publicConversationId),
            )!,
          ]
        : []),
      ...(reader.automationId
        ? [eq(juniorInboxItems.automationId, reader.automationId)]
        : []),
    ) ?? sql`false`
  );
}

/** Return whether an Inbox item is a public question (`action` item). */
function isPublicQuestion(item: InboxItem): boolean {
  return item.visibility === "public" && item.kind === "action";
}

/** Return whether a reader can see one Inbox item. */
export function canReadInboxItem(
  item: InboxItem,
  reader: InboxItemReader,
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
    (reader.publicConversationId !== undefined &&
      isPublicQuestion(item) &&
      item.conversationIds.includes(reader.publicConversationId)) ||
    (reader.automationId !== undefined &&
      item.automationId === reader.automationId)
  );
}

/**
 * Return whether a person can read one Inbox item: by the reader rule,
 * because they take part in a Conversation that the item links, or because
 * it is a public question that links a public Conversation, which every
 * signed-in person can view. The second part is the person rule of
 * `policies/conversation-access.md`; it lets the Conversation view show its
 * items. Viewing a public Conversation is not enough for a private item: it
 * stays private when its Conversation becomes public.
 */
export async function canUserReadInboxItem(
  item: InboxItem,
  user: User,
): Promise<boolean> {
  const todo = inboxItemTodo(item);
  if (todo) {
    // Only its assignee reads a To-do's item, while they can see the
    // Conversation (`inboxItemAssignedTo`).
    if (!item.assignees.some((assignee) => assignee.userId === user.id)) {
      return false;
    }
    const access = await readConversationAccessFromSql(
      getDb(),
      [todo.conversationId],
      user,
    );
    return access.get(todo.conversationId)?.canViewPrivateContent === true;
  }
  if (canReadInboxItem(item, inboxItemReaderForUser(user))) return true;
  const access = await readConversationAccessFromSql(
    getDb(),
    item.conversationIds,
    user,
  );
  return item.conversationIds.some((id) => {
    const conversation = access.get(id);
    return (
      conversation?.isParticipant === true ||
      (isPublicQuestion(item) && conversation?.visibility === "public")
    );
  });
}

/**
 * The reader for one person who looks at one Conversation: the person's
 * reader, plus the items linked to the Conversation when they take part in
 * it, or only its public questions when it is public. It is the list form of
 * `canUserReadInboxItem`.
 */
export async function inboxItemReaderForUserInConversation(
  user: User,
  conversationId: string,
): Promise<InboxItemReader> {
  const reader = inboxItemReaderForUser(user);
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    user,
  );
  const conversation = access.get(conversationId);
  if (conversation?.isParticipant) return { ...reader, conversationId };
  return conversation?.visibility === "public"
    ? { ...reader, publicConversationId: conversationId }
    : reader;
}

/** What an agent can see and change, from the Conversation it runs in. */
export interface InboxItemAgentScope {
  /**
   * Whether the Actor of the Turn is a person. A system Actor, such as the
   * Actor of an event Turn, is not.
   */
  actorIsPerson: boolean;
  /** Whether the current Conversation is not public. */
  inPrivateConversation: boolean;
  reader: InboxItemReader;
  /** Provider tenant of the current Conversation. */
  tenant?: ProviderTenant;
  user?: User;
}

/**
 * Read the scope of an agent. The agent reads as its Conversation and
 * Automation, not as its Actor: an assignment lets a person see the item on
 * the Inbox, not let an agent read it into another Conversation.
 */
export async function readInboxItemAgentScope(
  context: Pick<
    ToolRuntimeContext,
    "conversationId" | "resolveActorIdentity" | "source"
  >,
): Promise<InboxItemAgentScope> {
  // Only a user Identity resolves, so a system Actor has none.
  const actor = await context.resolveActorIdentity?.();
  const user = actor?.user;
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
    actorIsPerson: actor !== undefined,
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
export const PLUGIN_INBOX_ITEM_KEY_PREFIX = "plugin:";

/**
 * Dedupe keys with this prefix belong to Automation alerts, which core adds
 * and closes. An agent cannot use the prefix.
 */
export const AUTOMATION_INBOX_ITEM_KEY_PREFIX = "automation:";

/**
 * Dedupe keys with this prefix belong to To-dos for a person, which core
 * adds and closes as the To-do changes (`syncTodoInboxItems`). An agent
 * cannot use the prefix.
 */
export const TODO_INBOX_ITEM_KEY_PREFIX = "todo:";

/**
 * Return the To-do that an item shows, or undefined for any other item. The
 * key is `todo:<conversationId>:<todoId>`, and a Conversation id can hold
 * colons.
 */
export function inboxItemTodo(
  item: Pick<InboxItem, "dedupeKey">,
): { conversationId: string; id: number } | undefined {
  if (!item.dedupeKey.startsWith(TODO_INBOX_ITEM_KEY_PREFIX)) return undefined;
  const rest = item.dedupeKey.slice(TODO_INBOX_ITEM_KEY_PREFIX.length);
  const split = rest.lastIndexOf(":");
  const id = Number(rest.slice(split + 1));
  if (split <= 0 || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return { conversationId: rest.slice(0, split), id };
}

/**
 * Dedupe keys with this prefix belong to reply notices, which core adds for
 * the starter of a dashboard Conversation and closes when they read the
 * reply. An agent cannot use the prefix or change the item.
 */
export const REPLY_NOTICE_KEY_PREFIX = "reply:";

const USE_ANOTHER_KEY = "Use a different key.";

/**
 * The dedupe key prefixes that core and plugins own, with their owner and
 * what to do instead. The add tool's input schema rejects a key that starts
 * with one of them.
 */
export const RESERVED_INBOX_ITEM_KEY_PREFIXES = [
  {
    owner: "a plugin",
    prefix: PLUGIN_INBOX_ITEM_KEY_PREFIX,
    instead: USE_ANOTHER_KEY,
  },
  {
    owner: "an Automation alert",
    prefix: AUTOMATION_INBOX_ITEM_KEY_PREFIX,
    instead: USE_ANOTHER_KEY,
  },
  {
    owner: "a reply notice",
    prefix: REPLY_NOTICE_KEY_PREFIX,
    instead: USE_ANOTHER_KEY,
  },
  {
    owner: "a To-do",
    prefix: TODO_INBOX_ITEM_KEY_PREFIX,
    instead: `Assign a To-do to the person with ${UPDATE_TODOS_TOOL_NAME} instead.`,
  },
] as const;

/** Return the plugin that owns a dedupe key, or undefined for an agent's key. */
export function inboxItemPlugin(dedupeKey: string): string | undefined {
  if (!dedupeKey.startsWith(PLUGIN_INBOX_ITEM_KEY_PREFIX)) return undefined;
  const plugin = dedupeKey
    .slice(PLUGIN_INBOX_ITEM_KEY_PREFIX.length)
    .split(":", 1)[0];
  return plugin || undefined;
}

/** Return whether the item is an Automation alert. Core takes its answer. */
export function isAutomationAlertItem(item: Pick<InboxItem, "dedupeKey">) {
  return item.dedupeKey.startsWith(AUTOMATION_INBOX_ITEM_KEY_PREFIX);
}

/** Return whether a plugin added the item. Its answer goes to the plugin. */
export function isPluginInboxItem(item: Pick<InboxItem, "dedupeKey">) {
  return inboxItemPlugin(item.dedupeKey) !== undefined;
}

/**
 * Whether an agent can change an item. Only an agent in the tenant of the
 * item can change it. A public item changes only from a public
 * Conversation, so private content never reaches its readers. A private
 * item changes only from the Conversation or Automation that added it. An
 * agent never changes an item that a plugin added, or an item that another
 * owner kind, such as an Automation, owns, or a reply notice.
 */
export function canAgentChangeInboxItem(
  item: InboxItem,
  scope: InboxItemAgentScope,
): boolean {
  if (item.dedupeKey.startsWith(PLUGIN_INBOX_ITEM_KEY_PREFIX)) return false;
  if (item.dedupeKey.startsWith(TODO_INBOX_ITEM_KEY_PREFIX)) return false;
  if (item.dedupeKey.startsWith(REPLY_NOTICE_KEY_PREFIX)) return false;
  if (item.owner.kind !== "conversation") return false;
  if (!isSameTenant(item.tenant, scope.tenant)) return false;
  if (item.visibility === "public") return !scope.inPrivateConversation;
  return (
    item.owner.id === scope.reader.conversationId ||
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
export async function requireInboxItemLinks(args: {
  allowedIds: ReadonlySet<string>;
  conversationIds: readonly string[];
  scope: InboxItemAgentScope;
  tenant: ProviderTenant | undefined;
  visibility: InboxItemVisibility;
}): Promise<void> {
  const access = await readConversationAccessFromSql(
    getDb(),
    args.conversationIds,
    args.scope.user,
  );
  for (const conversationId of args.conversationIds) {
    const conversation = access.get(conversationId);
    if (!conversation || !isSameTenant(conversation.tenant, args.tenant)) {
      throw new ToolInputError(
        `Conversation ${conversationId} is not found. Check conversation_ids, or search Conversations to find the id.`,
      );
    }
    if (args.allowedIds.has(conversationId)) continue;
    if (args.visibility === "private") {
      throw new ToolInputError(
        "A private item links only to the Conversation that added it. Remove the other ids from `conversation_ids`.",
      );
    }
    if (conversation.visibility !== "public") {
      throw new ToolInputError(
        conversation.canViewPrivateContent
          ? `Conversation ${conversationId} is private. Only public Conversations can be linked.`
          : `Conversation ${conversationId} is not found. Check conversation_ids, or search Conversations to find the id.`,
      );
    }
  }
}

/**
 * Check who an agent assigns a private item to. It cannot go to Everyone.
 * Each User must be the current Actor, a Participant of one of the given
 * Conversations (the current one and, for an existing item, the one that
 * added it), or the creator of the Automation that added the item. An
 * Automation run often has no Actor and no people yet, and its creator wrote
 * the work. A public item can go to anyone.
 */
export async function requireInboxItemAssignees(args: {
  assignees: ResolvedAssignees;
  automationId: string | undefined;
  conversationIds: readonly string[];
  scope: InboxItemAgentScope;
  visibility: InboxItemVisibility;
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
  const inConversation = await conversationParticipantUserIds(
    getDb(),
    args.conversationIds,
    others,
  );
  if (others.some((id) => !inConversation.has(id))) {
    throw new ToolInputError(
      "A private item can be assigned only to people in its Conversation. Remove the other people from `assignees`.",
    );
  }
}

/**
 * Return whether an Inbox item is for Everyone. An item with no assignees
 * is for Everyone too: anyone who can see it can act on it, and it waits on
 * no one, so the Inbox shows it in Up for grabs and its count leaves it out.
 */
export function isInboxItemForEveryone(item: InboxItem): boolean {
  return item.assignedToEveryone || item.assignees.length === 0;
}

/**
 * Return whether a User can act on an open Inbox item: an assigned User, or
 * anyone for an item for Everyone (`isInboxItemForEveryone`). The caller
 * checks that the User can see the item. `inboxItemForUser` is the SQL form
 * of the assignee rule.
 */
export function canActOnInboxItem(item: InboxItem, userId: string): boolean {
  if (item.status !== "open") return false;
  if (isInboxItemForEveryone(item)) return true;
  return item.assignees.some((assignee) => assignee.userId === userId);
}

/**
 * Return whether a User can answer an open question. Anyone who can act on
 * it can (`canActOnInboxItem`). A public question that an agent asked in a
 * Conversation is open to anyone who can see it, such as a member of its
 * public Slack channel. A private item, a To-do, a plugin's item, and an
 * Automation alert keep the assignee rule, and so do Take and Dismiss. The
 * caller checks that the User can see the item.
 */
export function canAnswerInboxItem(item: InboxItem, userId: string): boolean {
  if (canActOnInboxItem(item, userId)) return true;
  return (
    item.status === "open" &&
    isPublicQuestion(item) &&
    item.request !== undefined &&
    item.owner.kind === "conversation" &&
    !isPluginInboxItem(item) &&
    inboxItemTodo(item) === undefined
  );
}

/**
 * Return whether an Inbox item needs a User: an open `action` item that is
 * assigned to them. `inboxItemNeedsUser` is the SQL form; keep the two the
 * same.
 */
export function itemNeedsUser(item: InboxItem, userId: string): boolean {
  return (
    item.status === "open" &&
    item.kind === "action" &&
    item.assignees.some((assignee) => assignee.userId === userId)
  );
}

/** Return whether a User is already the only assignee, so take does nothing. */
export function isOnlyAssignee(item: InboxItem, userId: string): boolean {
  return (
    !item.assignedToEveryone &&
    item.assignees.length === 1 &&
    item.assignees[0]?.userId === userId
  );
}
