/**
 * Visible-transcript sync between the in-memory turn working set and SQL.
 *
 * Visible-message events are the durable transcript and hydration authority;
 * `ConversationMessageStore` maintains only their SQL search read model, and
 * `ThreadConversationState.messages` is the current-turn working set. No
 * transcript data is persisted to `thread-state`.
 */
import { getConversationMessageStore } from "@/chat/db";
import { loadConversationEventHistory } from "./history-loader";
import { projectVisibleConversationCompactions } from "./visible-compactions";
import { projectVisibleConversationMessages } from "./visible-message-projection";
import { toStoredConversationMessage } from "./visible-message-serializer";
import { updateConversationStats } from "@/chat/services/conversation-memory";
import type { ThreadConversationState } from "@/chat/state/conversation";

/**
 * Replace the in-memory working set with the durable event-log transcript,
 * excluding messages already folded into a visible compaction summary.
 *
 * Hydrate is a first-read boundary, so it must trigger the once-only Redis→SQL
 * lazy import before reading events: consumers that hydrate before any model
 * projection read (turn-dedupe, delivered-message redelivery guards,
 * channel-context assembly) would otherwise make correctness decisions on an
 * empty transcript for promotion-window stragglers whose history is still only
 * in legacy Redis. The import is idempotent (skips when SQL event rows exist)
 * and no-ops cheaply when there is nothing legacy to read.
 */
export async function hydrateConversationMessages(args: {
  conversation: ThreadConversationState;
  conversationId: string | undefined;
}): Promise<void> {
  if (!args.conversationId) {
    args.conversation.messages = [];
    return;
  }
  const events = await loadConversationEventHistory({
    conversationId: args.conversationId,
  });
  args.conversation.compactions = projectVisibleConversationCompactions(events);
  const coveredIds = new Set(
    args.conversation.compactions.flatMap(
      (compaction) => compaction.coveredMessageIds,
    ),
  );
  args.conversation.messages = projectVisibleConversationMessages(
    events,
  ).filter((message) => !coveredIds.has(message.id));
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
