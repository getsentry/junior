/** Bounded legacy import followed by canonical conversation-event reads. */
import { getConversationEventStore } from "@/chat/db";
import { ensureLegacyConversationImport } from "./legacy-import";
import type { ConversationEvent } from "./history";

interface ScopedConversation {
  conversationId: string;
}

/** Ensure any pre-cutover transcript is represented in the canonical event log. */
export async function ensureConversationEventHistory(
  args: ScopedConversation,
): Promise<void> {
  await ensureLegacyConversationImport({ conversationId: args.conversationId });
}

/** Load the current event epoch after the bounded lazy legacy import. */
export async function loadCurrentConversationEvents(
  args: ScopedConversation,
): Promise<ConversationEvent[]> {
  await ensureConversationEventHistory(args);
  return getConversationEventStore().loadCurrentEpoch(args.conversationId);
}

/** Load complete event history after the bounded lazy legacy import. */
export async function loadConversationEventHistory(
  args: ScopedConversation,
): Promise<ConversationEvent[]> {
  await ensureConversationEventHistory(args);
  return getConversationEventStore().loadHistory(args.conversationId);
}
