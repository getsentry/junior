/**
 * Visible-transcript sync between the in-memory turn working set and SQL.
 *
 * Visible-message events are the durable transcript and hydration authority;
 * `ConversationMessageStore` maintains only their SQL search read model, and
 * `ThreadConversationState.messages` is the current-turn working set. No
 * transcript data is persisted to `thread-state`.
 */
import {
  getConversationEventStore,
  getConversationMessageStore,
} from "@/chat/db";
import { projectVisibleConversationCompactions } from "./visible-compactions";
import { projectVisibleConversationMessages } from "./visible-message-projection";
import { toStoredConversationMessage } from "./visible-message-serializer";
import { updateConversationStats } from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";

/**
 * Replace the in-memory working set with the durable event-log transcript,
 * excluding messages already folded into a visible compaction summary.
 *
 * SQL events are the only live history authority. The operator upgrade command
 * owns any pre-cutover Redis import before new workers serve the conversation.
 */
export async function hydrateConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
}): Promise<void> {
  if (!args.conversationId) {
    args.conversation.messages = [];
    return;
  }
  const history = await getConversationEventStore().loadVisibleHistory(
    args.conversationId,
  );
  args.conversation.compactions = history.compaction
    ? projectVisibleConversationCompactions([history.compaction])
    : [];
  args.conversation.messages = projectVisibleConversationMessages(
    history.events,
  );
  updateConversationStats(args.conversation);
}

/**
 * Append the working set's source facts and refresh the SQL search read model.
 * Content columns are insert-only and `meta` merges key-wise on conflict, so
 * repeated calls across a turn's persist points are safe.
 */
export async function persistConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
  repliedAtMs?: number;
}): Promise<void> {
  if (!args.conversationId || args.conversation.messages.length === 0) {
    return;
  }
  const store = getConversationMessageStore();
  await store.record(
    args.conversationId,
    args.conversation.messages.map(toStoredConversationMessage),
  );
  const repliedAtMs = args.repliedAtMs ?? Date.now();
  for (const message of args.conversation.messages) {
    if (message.meta?.replied === true) {
      await store.markReplied(args.conversationId, message.id, repliedAtMs);
    }
  }
}
