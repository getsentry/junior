import { isDeepStrictEqual } from "node:util";
import { getAgentStepStore } from "@/chat/db";
import type { StoredAgentStep } from "./history";
import type {
  ConversationCompaction,
  ThreadConversationState,
} from "@/chat/state/conversation";

function latestSnapshot(steps: StoredAgentStep[]): ConversationCompaction[] {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const entry = steps[index]?.entry;
    if (entry?.type === "visible_context_compacted") {
      return entry.compactions;
    }
  }
  return [];
}

/** Hydrate the durable visible-context compaction snapshot from SQL. */
export async function hydrateConversationCompactions(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const steps = await getAgentStepStore().loadHistory(args.conversationId);
  args.conversation.compactions = latestSnapshot(steps);
}

/** Persist a changed visible-context compaction snapshot in SQL agent history. */
export async function persistConversationCompactions(args: {
  conversation: ThreadConversationState;
  conversationId: string;
}): Promise<void> {
  const stepStore = getAgentStepStore();
  const existing = latestSnapshot(
    await stepStore.loadHistory(args.conversationId),
  );
  if (isDeepStrictEqual(existing, args.conversation.compactions)) {
    return;
  }
  await stepStore.append(args.conversationId, [
    {
      entry: {
        type: "visible_context_compacted",
        compactions: args.conversation.compactions,
      },
      createdAtMs:
        args.conversation.compactions.at(-1)?.createdAtMs ?? Date.now(),
    },
  ]);
}
