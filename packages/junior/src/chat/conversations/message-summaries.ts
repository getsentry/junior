import { isDeepStrictEqual } from "node:util";
import { getConversationEventStore } from "@/chat/db";
import type { ConversationEvent } from "./history";
import type {
  ConversationCompaction,
  ThreadConversationState,
} from "@/chat/state/conversation";

/** Project the latest source-message summary snapshot from event history. */
export function projectConversationMessageSummaries(
  events: ConversationEvent[],
): ConversationCompaction[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index]?.data;
    if (data?.type === "messages_summarized") {
      return data.compactions;
    }
  }
  return [];
}

/** Persist a changed source-message summary snapshot in event history. */
export async function persistConversationMessageSummaries(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const eventStore = getConversationEventStore();
  const history = await eventStore.loadMessageHistory(args.conversationId);
  const existing = history.compaction
    ? projectConversationMessageSummaries([history.compaction])
    : [];
  if (isDeepStrictEqual(existing, args.conversation.compactions)) {
    return;
  }
  const liveMessageIds = new Set(
    args.conversation.messages.map((message) => message.id),
  );
  const historyFromSeq = history.events.find(
    (event) =>
      event.data.type === "message" && liveMessageIds.has(event.data.messageId),
  )?.seq;
  const nextHistoryFromSeq =
    historyFromSeq ??
    Math.max(
      history.compaction?.data.type === "messages_summarized"
        ? history.compaction.data.historyFromSeq
        : 0,
      (history.events.at(-1)?.seq ?? -1) + 1,
    );
  await eventStore.append(args.conversationId, [
    {
      data: {
        type: "messages_summarized",
        historyFromSeq: nextHistoryFromSeq,
        compactions: args.conversation.compactions,
      },
      createdAtMs:
        args.conversation.compactions.at(-1)?.createdAtMs ?? Date.now(),
    },
  ]);
}
