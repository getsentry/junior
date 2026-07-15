import { eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

const MAX_LINEAGE_DEPTH = 32;

interface LineageRow {
  destinationId: string | null;
  parentId: string | null;
}

interface LineageCandidate {
  destinationId: string;
  rootConversationId: string;
}

async function readLineageRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<LineageRow | undefined> {
  const rows = await executor
    .db()
    .select({
      parentId: juniorConversations.parentConversationId,
      destinationId: juniorConversations.destinationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  return rows[0];
}

async function traceLineage(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<LineageCandidate | undefined> {
  let currentId = conversationId;
  const seen = new Set<string>();

  while (!seen.has(currentId) && seen.size < MAX_LINEAGE_DEPTH) {
    seen.add(currentId);
    const row = await readLineageRow(executor, currentId);
    if (!row) return undefined;

    if (row.parentId) {
      currentId = row.parentId;
      continue;
    }

    if (!row.destinationId) {
      return undefined;
    }
    return {
      destinationId: row.destinationId,
      rootConversationId: currentId,
    };
  }

  return undefined;
}

/**
 * Resolve a conversation's privacy authority from its persisted root.
 *
 * Parent links are immutable after insertion. Missing, cyclic, or over-depth
 * lineage fails closed, while the root destination is locked so callers that
 * keep the transaction open receive a stable visibility decision.
 */
export async function resolveRootVisibility(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<{
  rootConversationId: string;
  visibility: JuniorDestinationVisibility | null;
}> {
  const candidate = await traceLineage(executor, conversationId);
  if (!candidate) {
    return { rootConversationId: conversationId, visibility: null };
  }

  const destinations = await executor
    .db()
    .select({ visibility: juniorDestinations.visibility })
    .from(juniorDestinations)
    .where(eq(juniorDestinations.id, candidate.destinationId))
    .for("share");
  return {
    rootConversationId: candidate.rootConversationId,
    visibility: destinations[0]?.visibility ?? null,
  };
}
