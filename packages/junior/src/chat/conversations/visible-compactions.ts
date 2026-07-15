import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationEvent } from "./history";
import type {
  ConversationCompaction,
  ThreadConversationState,
} from "@/chat/state/conversation";

/** Project the latest visible-context compaction snapshot from event history. */
export function projectVisibleConversationCompactions(
  events: ConversationEvent[],
): ConversationCompaction[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index]?.data;
    if (data?.type === "visible_context_compacted") {
      return data.compactions;
    }
  }
  return [];
}

/** Persist a changed visible-context compaction snapshot in event history. */
export async function persistConversationCompactions(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const existing = projectVisibleConversationCompactions(
    await eventStore.loadHistory(args.conversationId),
  );
  if (isDeepStrictEqual(existing, args.conversation.compactions)) {
    return;
  }
  await eventStore.append(args.conversationId, [
    {
      data: {
        type: "visible_context_compacted",
        compactions: args.conversation.compactions,
      },
      createdAtMs:
        args.conversation.compactions.at(-1)?.createdAtMs ?? Date.now(),
    },
  ]);
}
