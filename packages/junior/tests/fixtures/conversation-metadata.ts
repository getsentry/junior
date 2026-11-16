import { writeConversationMetadata } from "@/chat/conversations/metadata/store";
import type { JuniorDatabase } from "@/db/db";

/** Store Conversation metadata as the metadata task would after a Turn. */
export async function storeConversationMetadataFixture(
  db: JuniorDatabase,
  input: {
    conversationId: string;
    summary?: string;
    throughSeq?: number;
  },
): Promise<void> {
  await writeConversationMetadata(db, {
    conversationId: input.conversationId,
    summary: input.summary ?? "The requested work is complete.",
    throughSeq: input.throughSeq ?? 0,
  });
}
