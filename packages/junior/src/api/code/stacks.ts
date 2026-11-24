import type { User } from "@sentry/junior-plugin-api";
import { eq, inArray, sql } from "drizzle-orm";
import { collectionRowTitle } from "@/chat/automations/read";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorAutomationRuns,
  juniorAutomations,
  juniorConversations,
} from "@/db/schema";
import { readConversationAccessFromSql } from "../conversations/access";
import type { CodeChangeStack } from "../schema/code";

/**
 * Read the stack of each code change: the Automation that ran its first
 * Conversation's root, or else that root. The first Conversation is the
 * earliest created one, since `conversation_ids` is sorted by id. A change
 * whose root the viewer may not read has no stack, so its title stays
 * hidden.
 */
export async function readCodeChangeStacks(
  db: JuniorDatabase,
  changes: readonly { conversationIds: readonly string[]; id: string }[],
  viewer: User | undefined,
): Promise<Map<string, CodeChangeStack>> {
  const linkedIds = [
    ...new Set(changes.flatMap((change) => change.conversationIds)),
  ];
  const createdAt = new Map(
    (linkedIds.length === 0
      ? []
      : await db
          .select({
            conversationId: juniorConversations.conversationId,
            createdAt: juniorConversations.createdAt,
          })
          .from(juniorConversations)
          .where(inArray(juniorConversations.conversationId, linkedIds))
    ).map((row) => [row.conversationId, row.createdAt.getTime()]),
  );
  const firstIds = new Map(
    changes.flatMap((change) => {
      const [first] = change.conversationIds
        .filter((id) => createdAt.has(id))
        .sort(
          (a, b) => createdAt.get(a)! - createdAt.get(b)! || a.localeCompare(b),
        );
      return first ? [[change.id, first] as const] : [];
    }),
  );
  const access = await readConversationAccessFromSql(
    db,
    [...new Set(firstIds.values())],
    viewer,
  );
  const rootIds = [
    ...new Set(
      [...access.values()].flatMap((entry) =>
        entry.canViewPrivateContent && entry.rootConversationId
          ? [entry.rootConversationId]
          : [],
      ),
    ),
  ];
  const roots =
    rootIds.length === 0
      ? []
      : await db
          .select({
            automationId: juniorAutomations.id,
            automationKind: juniorAutomations.kind,
            automationTask: sql<unknown>`${juniorAutomations.record}->'task'`,
            automationTitle: juniorAutomations.title,
            conversationId: juniorConversations.conversationId,
            title: juniorConversations.title,
          })
          .from(juniorConversations)
          .leftJoin(
            juniorAutomationRuns,
            eq(
              juniorAutomationRuns.conversationId,
              juniorConversations.conversationId,
            ),
          )
          .leftJoin(
            juniorAutomations,
            eq(juniorAutomations.id, juniorAutomationRuns.automationId),
          )
          .where(inArray(juniorConversations.conversationId, rootIds));
  const stackOfRoot = new Map(
    roots.map((root): [string, CodeChangeStack] => [
      root.conversationId,
      root.automationId && root.automationKind
        ? {
            id: root.automationId,
            kind: "automation",
            // Named as the Automations list names it.
            title: collectionRowTitle({
              kind: root.automationKind,
              task: root.automationTask,
              title: root.automationTitle,
            }),
          }
        : {
            id: root.conversationId,
            kind: "conversation",
            ...(root.title ? { title: root.title } : undefined),
          },
    ]),
  );
  const stacks = new Map<string, CodeChangeStack>();
  for (const [changeId, conversationId] of firstIds) {
    const entry = access.get(conversationId);
    const stack =
      entry?.canViewPrivateContent && entry.rootConversationId
        ? stackOfRoot.get(entry.rootConversationId)
        : undefined;
    if (stack) stacks.set(changeId, stack);
  }
  return stacks;
}
