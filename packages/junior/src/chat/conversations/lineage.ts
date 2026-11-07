import { desc, eq, sql } from "drizzle-orm";
import {
  resolveConversationPrivacy,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { Location } from "@/chat/conversations/location";
import { getDb } from "@/chat/db";
import { parseSessionSource } from "@/chat/source";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import { locationFromRow, visibilityFromLocationRow } from "./sql/location";

/** One Conversation in a parent chain. */
export interface ConversationLineageEntry {
  conversationId: string;
  location?: Location;
  parentConversationId?: string;
  visibility?: ConversationPrivacy;
}

/**
 * Read the parent chain of a Conversation in one query, root first, with the
 * Conversation last. Returns an empty list when the Conversation is missing.
 *
 * The chain stops at a parent that is missing or that is already in the
 * chain. Then the first entry still has a `parentConversationId`, so callers
 * can tell a broken chain from one that ends at a root.
 */
export async function readConversationLineage(
  conversationId: string,
): Promise<ConversationLineageEntry[]> {
  // The path stops the walk at the first repeated id, so a bad parent link
  // cannot loop forever.
  const lineage = sql`(
    with recursive lineage(conversation_id, parent_conversation_id, depth, path) as (
      select selected.conversation_id, selected.parent_conversation_id, 0, array[selected.conversation_id]
      from junior_conversations selected
      where selected.conversation_id = ${conversationId}
      union all
      select parent.conversation_id, parent.parent_conversation_id, lineage.depth + 1, lineage.path || parent.conversation_id
      from junior_conversations parent
      join lineage on parent.conversation_id = lineage.parent_conversation_id
      where parent.conversation_id <> all(lineage.path)
    )
    select conversation_id, depth from lineage
  ) conversation_lineage`;
  const rows = await getDb()
    .select({
      conversationId: juniorConversations.conversationId,
      destination: juniorDestinations,
      location: juniorConversations.location,
      parentConversationId: juniorConversations.parentConversationId,
      sessionSource: juniorConversations.sessionSource,
    })
    .from(juniorConversations)
    .innerJoin(
      lineage,
      eq(
        sql`conversation_lineage.conversation_id`,
        juniorConversations.conversationId,
      ),
    )
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .orderBy(desc(sql`conversation_lineage.depth`));
  return rows.map((row) => {
    const location = locationFromRow(
      row.location,
      row.destination,
      parseSessionSource(row.sessionSource),
    );
    const visibility = visibilityFromLocationRow(row.destination);
    return {
      conversationId: row.conversationId,
      ...(location ? { location } : undefined),
      ...(row.parentConversationId
        ? { parentConversationId: row.parentConversationId }
        : undefined),
      ...(visibility ? { visibility } : undefined),
    };
  });
}

/** Where a Run in one Conversation takes its config and visibility from. */
export interface RunPlacement {
  /** Location of the root, whose provider defaults the Run uses. */
  configLocation?: Location;
  /**
   * Parent links above the Conversation. A root has depth 0. A broken chain
   * also counts the link to the parent that it could not read.
   */
  depth: number;
  /** Visibility of the root. Missing or unknown visibility is private. */
  visibility: ConversationPrivacy;
}

/**
 * Resolve the placement of a root or child Conversation from its root. A
 * child row stores no Location or visibility of its own.
 */
export async function resolveRunPlacement(
  conversationId: string,
): Promise<RunPlacement> {
  const lineage = await readConversationLineage(conversationId);
  const root = lineage[0]?.parentConversationId ? undefined : lineage[0];
  return {
    ...(root?.location ? { configLocation: root.location } : undefined),
    depth: root ? lineage.length - 1 : lineage.length,
    visibility: resolveConversationPrivacy({ visibility: root?.visibility }),
  };
}
