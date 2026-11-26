// The agent history that core gives the model: the agent history items of the
// current History version, after the History replacement that starts it.
// Every other event type in the Conversation is the host's, and core does not
// read it. The host gives the model its facts as inputs or prompt fragments.
import { and, asc, eq, inArray, max } from "drizzle-orm";
import {
  agentHistoryItemSchema,
  historyReplacementDataSchema,
} from "@/chat/conversations/history";
import { eventFromRow } from "@/chat/conversations/sql/history";
import { piMessageFromHistoryItem } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import type { EngineContext } from "@/core/engine-context";
import { juniorConversationEvents } from "@/db/schema";

// The schemas name the types, so a new item or replacement type is read too.
const READ_TYPES = [
  ...agentHistoryItemSchema.options,
  ...historyReplacementDataSchema.options,
  // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is zod's object API field.
].map((option) => option.shape.type.value);

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
    const { data } = eventFromRow(row);
    const item = agentHistoryItemSchema.safeParse(data);
    if (item.success) {
      return [piMessageFromHistoryItem(item.data)];
    }
    // A History replacement is the first event of its version.
    return historyReplacementDataSchema
      .parse(data)
      .replacementHistory.map(({ item }) => piMessageFromHistoryItem(item));
  });
}
