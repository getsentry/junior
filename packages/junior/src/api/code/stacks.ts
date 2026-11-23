import type { User } from "@sentry/junior-plugin-api";
import { eq, inArray } from "drizzle-orm";
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
 * Conversation's root, or else that root. A change whose root the viewer
 * may not read has no stack, so its title stays hidden.
 */
export async function readCodeChangeStacks(
  db: JuniorDatabase,
  changes: readonly { conversationIds: readonly string[]; id: string }[],
  viewer: User | undefined,
): Promise<Map<string, CodeChangeStack>> {
  const firstIds = new Map(
    changes.flatMap((change) =>
      change.conversationIds[0] ? [[change.id, change.conversationIds[0]]] : [],
    ),
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
      root.automationId
        ? {
            id: root.automationId,
            kind: "automation",
            ...(root.automationTitle
              ? { title: root.automationTitle }
              : undefined),
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
