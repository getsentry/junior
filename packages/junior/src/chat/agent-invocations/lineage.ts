import {
  readConversationLineage,
  type ConversationLineageEntry,
} from "@/chat/conversations/lineage";
import type { Location } from "@/chat/conversations/location";

/**
 * Read how many parents a child Conversation has, and the root Conversation
 * with its Location. A child of the root has depth 1. A broken chain has no
 * root.
 */
export async function readChildDepthAndRootLocation(
  conversationId: string,
): Promise<{
  depth: number;
  location?: Location;
  root?: ConversationLineageEntry;
}> {
  const lineage = await readConversationLineage(conversationId);
  const root = lineage[0];
  if (!root) {
    return { depth: 0 };
  }
  // A broken chain also counts the link to the parent that it could not read.
  return root.parentConversationId
    ? { depth: lineage.length }
    : { depth: lineage.length - 1, location: root.location, root };
}
