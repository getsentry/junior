import type { User } from "@sentry/junior-plugin-api";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import type { ReviewItemPayload } from "@/api/schema/review-item";
import type { ReviewItem } from "@/chat/review-items/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAgentBindings,
  juniorAgentInvocations,
  juniorConversations,
} from "@/db/schema";

type AddedByChild = NonNullable<ReviewItemPayload["addedByChild"]>;

/** Name a child with no title by its kind: "Thread" or "Task". */
function kindLabel(kind: string | null): string {
  return kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)}` : "Child agent";
}

/**
 * Read where each child Conversation that added an item sits: its root and
 * its label, such as the Thread title. The Inbox shows those items in the
 * stack of the root. A child is left out when the viewer cannot see its
 * root's content, so the viewer learns no root, title, or name of a tree
 * they cannot see (`policies/conversation-access.md`, rule for people).
 */
export async function readAddedByChildren(
  db: JuniorDatabase,
  items: readonly Pick<
    ReviewItem,
    "addedByConversationId" | "fromChildAgent"
  >[],
  viewer: User,
): Promise<Map<string, AddedByChild>> {
  // A search already says which items a child added. Most come from roots,
  // and then no read follows.
  const ids = [
    ...new Set(
      items.flatMap((item) =>
        item.fromChildAgent === false ? [] : [item.addedByConversationId],
      ),
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
  const [access, invocations] = await Promise.all([
    readConversationAccessFromSql(db, childIds, viewer),
    // An Agent invocation names its child best: a titled one first, then
    // the newest.
    db
      .selectDistinctOn([juniorAgentInvocations.childConversationId], {
        agentName: juniorAgentInvocations.agentName,
        childConversationId: juniorAgentInvocations.childConversationId,
        title: juniorAgentInvocations.title,
      })
      .from(juniorAgentInvocations)
      .where(inArray(juniorAgentInvocations.childConversationId, childIds))
      .orderBy(
        juniorAgentInvocations.childConversationId,
        sql`${juniorAgentInvocations.title} is null`,
        desc(juniorAgentInvocations.createdAt),
      ),
  ]);
  const invocationByChild = new Map(
    invocations.map((row) => [row.childConversationId, row]),
  );
  return new Map(
    children.flatMap((child) => {
      const childAccess = access.get(child.conversationId);
      const rootConversationId = childAccess?.rootConversationId;
      if (!rootConversationId || !childAccess.canViewPrivateContent) return [];
      const invocation = invocationByChild.get(child.conversationId);
      const label =
        invocation?.title ??
        invocation?.agentName ??
        child.title ??
        child.bindingName ??
        kindLabel(child.kind);
      return [[child.conversationId, { label, rootConversationId }] as const];
    }),
  );
}
