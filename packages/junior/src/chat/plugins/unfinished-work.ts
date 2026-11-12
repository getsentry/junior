import { inArray } from "drizzle-orm";
import { createPluginCache } from "@/chat/plugins/cache";
import { getDb } from "@/chat/db";
import { getPlugins } from "@/chat/plugins/agent-hooks";
import { createPluginLogger } from "@/chat/plugins/logging";
import { logWarn } from "@/chat/logging";
import { juniorConversations } from "@/db/schema";

export type ConversationWork = {
  assignedIds: string[];
  /**
   * A plugin hook failed, so missing work may be unreported. Feed Priority
   * fails open; auto-archive must not read missing work as done.
   */
  failed: boolean;
  /** Latest finish time per conversation, used with activity for Priority. */
  finishedAtById: Record<string, string>;
  unfinishedIds: string[];
};

export type ConversationDoneInput = {
  assignedWork?: boolean;
  finishedWorkAt?: string;
  lastUserMessageAt?: string;
  unfinishedWork?: boolean;
};

/**
 * Decide whether a conversation's work finished at or before the cutoff,
 * with no person's message after it finished. Auto-archive passes now minus
 * the grace period. A conversation without plugin-reported work has nothing
 * to wait for, so it counts as done here; cache warming needs reported work
 * and checks `assignedWork` itself.
 */
export function isConversationWorkDone(
  conversation: ConversationDoneInput,
  cutoffMs: number,
): boolean {
  if (conversation.unfinishedWork) return false;
  if (!conversation.assignedWork) return true;
  const finishedAt = Date.parse(conversation.finishedWorkAt ?? "");
  if (!Number.isFinite(finishedAt) || finishedAt > cutoffMs) return false;
  const lastUserMessageAt = Date.parse(conversation.lastUserMessageAt ?? "");
  return !(
    Number.isFinite(lastUserMessageAt) && lastUserMessageAt > finishedAt
  );
}

/**
 * Map each candidate and each child of a candidate root to the candidate it
 * counts for. A child agent runs under its own conversation id, so a plugin
 * links the work that the child does, such as a pull request, to the child.
 */
async function readWorkOwners(
  conversationIds: string[],
): Promise<Map<string, string>> {
  const owners = new Map(conversationIds.map((id) => [id, id]));
  const children = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      rootConversationId: juniorConversations.rootConversationId,
    })
    .from(juniorConversations)
    .where(inArray(juniorConversations.rootConversationId, conversationIds));
  for (const child of children) {
    if (child.rootConversationId && !owners.has(child.conversationId)) {
      owners.set(child.conversationId, child.rootConversationId);
    }
  }
  return owners;
}

/**
 * Return assigned and unfinished plugin work for the candidate conversations.
 * Work in a child conversation counts for its root candidate. Feed Priority
 * combines these signals with conversation activity on the host.
 */
export async function listConversationWork(
  conversationIds: string[],
): Promise<ConversationWork> {
  if (conversationIds.length === 0) {
    return {
      assignedIds: [],
      failed: false,
      finishedAtById: {},
      unfinishedIds: [],
    };
  }
  const owners = await readWorkOwners(conversationIds);
  const queriedIds = [...owners.keys()];
  const assigned = new Set<string>();
  const finishedAtById = new Map<string, string>();
  const unfinished = new Set<string>();
  let failed = false;
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.unfinishedWork;
    if (!hook) continue;
    try {
      const result = await hook({
        conversationIds: queriedIds,
        db: getDb(),
        log: createPluginLogger(plugin.manifest.name),
        plugin: { name: plugin.manifest.name },
        cache: createPluginCache(plugin.manifest.name),
      });
      for (const workId of result.conversationIds) {
        const conversationId = owners.get(workId);
        if (!conversationId) continue;
        unfinished.add(conversationId);
        assigned.add(conversationId);
      }
      for (const workId of result.assignedConversationIds ?? []) {
        const conversationId = owners.get(workId);
        if (conversationId) assigned.add(conversationId);
      }
      for (const [workId, finishedAt] of Object.entries(
        result.finishedWorkAtByConversationId ?? {},
      )) {
        const conversationId = owners.get(workId);
        if (!conversationId) continue;
        const time = Date.parse(finishedAt);
        if (!Number.isFinite(time)) continue;
        const current = finishedAtById.get(conversationId);
        if (!current || time > Date.parse(current)) {
          finishedAtById.set(conversationId, finishedAt);
        }
      }
    } catch (error) {
      failed = true;
      // Fail open: a broken plugin must not invent assigned or unfinished work
      // and demote recent conversations out of Priority.
      logWarn("plugin.unfinished_work.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    assignedIds: conversationIds.filter((conversationId) =>
      assigned.has(conversationId),
    ),
    failed,
    finishedAtById: Object.fromEntries(
      conversationIds.flatMap((conversationId) => {
        const finishedAt = finishedAtById.get(conversationId);
        return finishedAt ? [[conversationId, finishedAt]] : [];
      }),
    ),
    unfinishedIds: conversationIds.filter((conversationId) =>
      unfinished.has(conversationId),
    ),
  };
}

/** Return candidate conversations that have unfinished plugin work. */
export async function listUnfinishedWork(
  conversationIds: string[],
): Promise<string[]> {
  return (await listConversationWork(conversationIds)).unfinishedIds;
}
