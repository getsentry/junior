import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { hasAssigneeRoles } from "@/chat/inbox-items/plugin-dismiss";
import { ownerConversationId, type InboxItem } from "@/chat/inbox-items/store";
import type { JuniorDatabase } from "@/db/db";
import { juniorAgentBindings, juniorConversations } from "@/db/schema";

/** Where an item sits in its Conversation tree, for the Inbox's stacks. */
type ItemRoot = { label: string; rootConversationId: string };

/** Name a child with no title by its kind: "Thread" or "Task". */
function kindLabel(kind: string | null): string {
  return kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)}` : "Child agent";
}

/**
 * Read the root of each Conversation that owns an item, at any depth, from
 * the root that each Conversation stores, with a label for a child, such as
 * its Thread title. A root needs no read. A child is left out when the
 * viewer cannot see its root's content, so the viewer learns no root,
 * title, or name of a tree they cannot see
 * (`policies/conversation-access.md`, rule for people). The payload then
 * names the owner Conversation as its root.
 */
export async function readItemRoots(
  db: JuniorDatabase,
  items: readonly Pick<InboxItem, "owner" | "ownerRootConversationId">[],
  viewer: User,
): Promise<Map<string, ItemRoot>> {
  // A search already read each owner's stored root. Most items come from
  // roots, and then no read follows. An owner of another kind has no root.
  const ids = [
    ...new Set(
      items.flatMap((item) => {
        const conversationId = ownerConversationId(item);
        return !conversationId ||
          item.ownerRootConversationId === null ||
          item.ownerRootConversationId === conversationId
          ? []
          : [conversationId];
      }),
    ),
  ];
  if (ids.length === 0) return new Map();
  const children = await db
    .select({
      bindingName: juniorAgentBindings.name,
      conversationId: juniorConversations.conversationId,
      kind: juniorConversations.kind,
      title: juniorConversations.title,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorAgentBindings,
      eq(
        juniorAgentBindings.childConversationId,
        juniorConversations.conversationId,
      ),
    )
    .where(
      and(
        inArray(juniorConversations.conversationId, ids),
        isNotNull(juniorConversations.parentConversationId),
      ),
    );
  if (children.length === 0) return new Map();
  const childIds = children.map((child) => child.conversationId);
  const access = await readConversationAccessFromSql(db, childIds, viewer);
  return new Map(
    children.flatMap((child) => {
      const childAccess = access.get(child.conversationId);
      const rootConversationId = childAccess?.rootConversationId;
      if (!rootConversationId || !childAccess.canViewPrivateContent) return [];
      const label = child.title ?? child.bindingName ?? kindLabel(child.kind);
      return [[child.conversationId, { label, rootConversationId }] as const];
    }),
  );
}

/**
 * Read the owner Conversations of a page of items that the viewer cannot
 * see. Only a role on a plugin item's object (`assigneeRoles`) puts a
 * person on an item outside its Conversation, so only those owners are
 * read. Their card then shows the item and its subject, and no
 * Conversation.
 */
export async function readHiddenOwners(
  db: JuniorDatabase,
  items: readonly Pick<InboxItem, "owner" | "subject">[],
  viewer: User,
): Promise<Set<string>> {
  const ids = [
    ...new Set(
      items.flatMap((item) =>
        hasAssigneeRoles(item) ? (ownerConversationId(item) ?? []) : [],
      ),
    ),
  ];
  if (ids.length === 0) return new Set();
  const access = await readConversationAccessFromSql(db, ids, viewer);
  return new Set(ids.filter((id) => !access.get(id)?.canViewPrivateContent));
}
