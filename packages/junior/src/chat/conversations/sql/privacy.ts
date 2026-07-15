import { eq } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

const MAX_LINEAGE_DEPTH = 32;

interface LineageRow {
  destinationId: string | null;
  parentId: string | null;
  rootId: string | null;
}

interface LineageCandidate {
  path: string[];
  rootConversationId: string;
}

async function readLineageRow(
  executor: JuniorSqlDatabase,
  conversationId: string,
  lock: boolean,
): Promise<LineageRow | undefined> {
  const query = executor
    .db()
    .select({
      parentId: juniorConversations.parentConversationId,
      rootId: juniorConversations.rootConversationId,
      destinationId: juniorConversations.destinationId,
    })
    .from(juniorConversations)
    .where(eq(juniorConversations.conversationId, conversationId));
  const rows = lock ? await query.for("share") : await query;
  return rows[0];
}

async function traceLineage(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<LineageCandidate | undefined> {
  let currentId = conversationId;
  let declaredRootId: string | null | undefined;
  const path: string[] = [];
  const seen = new Set<string>();

  while (!seen.has(currentId) && seen.size < MAX_LINEAGE_DEPTH) {
    seen.add(currentId);
    path.push(currentId);
    const row = await readLineageRow(executor, currentId, false);
    if (!row) return undefined;

    if (declaredRootId === undefined) declaredRootId = row.rootId;
    if (row.parentId) {
      if (!declaredRootId || row.rootId !== declaredRootId) return undefined;
      currentId = row.parentId;
      continue;
    }

    if (
      row.rootId !== null ||
      (declaredRootId !== null && declaredRootId !== currentId) ||
      !row.destinationId
    ) {
      return undefined;
    }
    return { path, rootConversationId: currentId };
  }

  return undefined;
}

function lockedLineageIsConsistent(
  candidate: LineageCandidate,
  rows: Map<string, LineageRow>,
): boolean {
  const declaredRootId = rows.get(candidate.path[0]!)?.rootId;
  for (const [index, conversationId] of candidate.path.entries()) {
    const row = rows.get(conversationId);
    if (!row) return false;
    const expectedParentId = candidate.path[index + 1] ?? null;
    if (row.parentId !== expectedParentId) return false;
    if (expectedParentId) {
      if (!declaredRootId || row.rootId !== declaredRootId) return false;
      continue;
    }
    if (
      row.rootId !== null ||
      (declaredRootId !== null &&
        declaredRootId !== candidate.rootConversationId) ||
      !row.destinationId
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a conversation's privacy authority from its persisted root.
 *
 * The lineage is discovered without locks, then locked and revalidated from
 * root to requested conversation. Root-first ordering matches tree purges;
 * callers that keep the transaction open receive a stable privacy decision.
 * Missing, cyclic, over-depth, historically uncorrelated, or internally
 * inconsistent lineage fails closed.
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

  const rootRow = await readLineageRow(
    executor,
    candidate.rootConversationId,
    true,
  );
  if (!rootRow?.destinationId) {
    return {
      rootConversationId: candidate.rootConversationId,
      visibility: null,
    };
  }
  const destinations = await executor
    .db()
    .select({ visibility: juniorDestinations.visibility })
    .from(juniorDestinations)
    .where(eq(juniorDestinations.id, rootRow.destinationId))
    .for("share");

  const lockedRows = new Map<string, LineageRow>([
    [candidate.rootConversationId, rootRow],
  ]);
  for (const id of [...candidate.path].reverse().slice(1)) {
    const row = await readLineageRow(executor, id, true);
    if (!row) {
      return {
        rootConversationId: candidate.rootConversationId,
        visibility: null,
      };
    }
    lockedRows.set(id, row);
  }
  if (!lockedLineageIsConsistent(candidate, lockedRows)) {
    return {
      rootConversationId: candidate.rootConversationId,
      visibility: null,
    };
  }
  return {
    rootConversationId: candidate.rootConversationId,
    visibility: destinations[0]?.visibility ?? null,
  };
}
