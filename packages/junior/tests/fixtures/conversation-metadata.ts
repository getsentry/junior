import type { ConversationOutcomeStatus } from "@/chat/conversations/metadata/schema";
import { writeConversationMetadata } from "@/chat/conversations/metadata/store";
import type { JuniorDatabase } from "@/db/db";

/** Store Conversation metadata as the metadata task would after a Turn. */
export async function storeConversationMetadataFixture(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    outcomeStatus?: ConversationOutcomeStatus;
    summary?: string;
    throughSeq?: number;
  },
): Promise<void> {
  await writeConversationMetadata(db, {
    conversationId: input.conversationId,
    outcomeStatus: input.outcomeStatus ?? "done",
    summary: input.summary ?? "The requested work is complete.",
    throughSeq: input.throughSeq ?? 0,
  });
}
