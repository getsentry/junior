import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationEvent } from "./history";
import type {
  ConversationCompaction,
  ThreadConversationState,
} from "@/chat/state/conversation";

function latestSnapshot(events: ConversationEvent[]): ConversationCompaction[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index]?.data;
    if (data?.type === "visible_context_compacted") {
      return data.compactions;
    }
  }
  return [];
}

/** Hydrate the durable visible-context compaction snapshot from SQL. */
export async function hydrateConversationCompactions(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const events = await getConversationEventStore().loadHistory(
    args.conversationId,
  );
  args.conversation.compactions = latestSnapshot(events);
}

/** Persist a changed visible-context compaction snapshot in event history. */
export async function persistConversationCompactions(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const existing = latestSnapshot(
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
