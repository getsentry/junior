// The agent history that core gives the model: the agent history items of the
// current History version, after the History replacement that starts it.
// Every other event type in the Conversation is the host's, and core does not
// read it. The host gives the model its facts as inputs or prompt fragments.
import {
  AGENT_HISTORY_ITEM_TYPES,
  HISTORY_REPLACEMENT_TYPES,
  isHistoryReplacement,
  piMessageFromHistoryItem,
} from "./items";
import { agentHistoryFromRow } from "./rows";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import type { PiMessage } from "@/chat/pi/messages";
import type { EngineContext } from "@/core/engine-context";
import { juniorConversationEvents } from "@/db/schema";

const READ_TYPES = [...AGENT_HISTORY_ITEM_TYPES, ...HISTORY_REPLACEMENT_TYPES];

/** Loads the current History version's agent history, as the model reads it. */
export async function loadAgentHistory(
  { executor }: Pick<EngineContext, "executor">,
  conversationId: string,
): Promise<PiMessage[]> {
  const db = executor.db();
  // One statement: the current version and its events come from one snapshot.
  const currentHistoryVersionQuery = db
    .select({ historyVersion: max(juniorConversationEvents.historyVersion) })
    .from(juniorConversationEvents)
    .where(eq(juniorConversationEvents.conversationId, conversationId));
  const rows = await db
    .select()
    .from(juniorConversationEvents)
    .where(
      and(
        eq(juniorConversationEvents.conversationId, conversationId),
        eq(juniorConversationEvents.historyVersion, currentHistoryVersionQuery),
        inArray(juniorConversationEvents.type, READ_TYPES),
      ),
    )
    .orderBy(asc(juniorConversationEvents.seq));
  return rows.flatMap((row) => {
    const data = agentHistoryFromRow(row);
    // A History replacement is the first event of its version.
    return isHistoryReplacement(data)
      ? data.replacementHistory.map(({ item }) =>
          piMessageFromHistoryItem(item),
        )
      : [piMessageFromHistoryItem(data)];
  });
}
