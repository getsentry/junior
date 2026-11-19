import { createHash } from "node:crypto";
import type { ConversationFeed } from "../schema/conversation-feed";

/**
 * Hash one feed page without its read time, so two reads of an unchanged
 * page get the same token. The page is already built, so a match saves the
 * download and the client parse, not the read.
 */
export function conversationFeedPageVersion(feed: ConversationFeed): string {
  const { generatedAt: _generatedAt, ...content } = feed;
  return createHash("sha256")
    .update(JSON.stringify(content))
    .digest("base64url");
}
