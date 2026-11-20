import { readLastUserMessageAtByConversation } from "@/api/conversations/user-message-activity";
import { rootConversationIsArchived } from "@/chat/conversations/sql/participants";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import {
  isConversationWorkDone,
  listConversationWork,
} from "@/chat/plugins/unfinished-work";
import type { WorkState } from "./model";

/**
 * Read the plugin work state and the archive state of a Conversation when an
 * idle period starts that Junior can warm. Work of child Conversations counts
 * for their root. A child counts as archived when it or its root is: a manual
 * archive also archives the children, but auto-archive sets only the root.
 */
export async function readSegmentState(
  conversationId: string,
  nowMs: number,
): Promise<{ workState: WorkState; archived: boolean }> {
  const [work, conversation, rootArchived] = await Promise.all([
    listConversationWork([conversationId]),
    getConversationStore().get({ conversationId }),
    rootConversationIsArchived(getSqlExecutor(), conversationId),
  ]);
  const archived = rootArchived || conversation?.archivedAtMs !== undefined;
  // A failed hook can hide open work. `none` keeps the segment that most
  // Conversations use, so warming goes on as without plugin work.
  if (work.failed || !work.assignedIds.includes(conversationId)) {
    return { workState: "none", archived };
  }
  if (work.unfinishedIds.includes(conversationId)) {
    return { workState: "open", archived };
  }
  const lastUserMessageAt = (
    await readLastUserMessageAtByConversation(getDb(), [conversationId])
  ).get(conversationId);
  // No grace period: the work is done when it finished before now.
  const done = isConversationWorkDone(
    {
      assignedWork: true,
      finishedWorkAt: work.finishedAtById[conversationId],
      lastUserMessageAt,
    },
    nowMs,
  );
  return { workState: done ? "done" : "none", archived };
}
