import { readConversationFeedFromSql } from "./list.query";
import type { ConversationFeed } from "./types";

/** Load the conversation feed directly from durable SQL records. */
export async function readConversationFeed(): Promise<ConversationFeed> {
  return readConversationFeedFromSql();
}

export type {
  ActorIdentity,
  ConversationCost,
  ConversationFeed,
  ConversationReportStatus,
  ConversationSummaryReport,
  ConversationSurface,
  ConversationUsage,
} from "./types";
