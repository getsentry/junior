import { CORE_FEATURE_COMPACTION_SNAPSHOT } from "@/chat/core-features/runtime";

/**
 * State of a core feature that a compaction summary must keep, so it
 * survives the History replacement.
 */
export type CompactionSnapshot = {
  /** Turn context tags whose sections the snapshot replaces. */
  replacedTags: readonly string[];
  /** Read the snapshot text of one Conversation, or null for none. */
  load(conversationId: string): Promise<string | null>;
};

/**
 * Append the snapshot of core features, read from the database, to the
 * text of a compaction summary.
 */
export async function appendCompactionSnapshot(
  summaryText: string,
  conversationId: string,
): Promise<string> {
  const snapshot = await CORE_FEATURE_COMPACTION_SNAPSHOT.load(conversationId);
  return snapshot ? `${summaryText}\n\n${snapshot}` : summaryText;
}
