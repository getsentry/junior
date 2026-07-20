import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

const MAX_LINEAGE_DEPTH = 32;
const conversationEventColumns = getTableColumns(juniorConversationEvents);

interface LineageRow {
  destinationId: string | null;
  parentId: string | null;
}

interface LineageCandidate {
  destinationId: string;
  rootConversationId: string;
}

/** Root conversation identity and its normalized destination visibility. */
export interface RootConversationVisibility {
  rootConversationId: string;
  visibility: JuniorDestinationVisibility | null;
}

type ConversationEventPrivacySnapshot = RootConversationVisibility & {
  events: Array<typeof juniorConversationEvents.$inferSelect>;
};

function rootVisibilitySnapshotSql(conversationId: string) {
  return sql<RootConversationVisibility>`(
    with recursive lineage(
      conversation_id,
      parent_conversation_id,
      destination_id,
      path,
      depth
    ) as (
      select
        requested.conversation_id,
        requested.parent_conversation_id,
        requested.destination_id,
        array[requested.conversation_id]::text[],
        1
      from junior_conversations requested
      where requested.conversation_id = ${conversationId}

      union all

      select
        parent.conversation_id,
        parent.parent_conversation_id,
        parent.destination_id,
        lineage.path || parent.conversation_id,
        lineage.depth + 1
      from lineage
      join junior_conversations parent
        on parent.conversation_id = lineage.parent_conversation_id
      where lineage.depth < ${MAX_LINEAGE_DEPTH}
        and not (parent.conversation_id = any(lineage.path))
    ),
    root_candidate as (
      select lineage.conversation_id, lineage.destination_id
      from lineage
      where lineage.parent_conversation_id is null
        and lineage.destination_id is not null
      limit 1
    )
    select jsonb_build_object(
      'rootConversationId', coalesce(root.conversation_id, ${conversationId}),
      'visibility', destination.visibility
    )
    from (select 1) seed
    left join root_candidate root on true
    left join junior_destinations destination
      on destination.id = root.destination_id
  )`;
}

/**
 * Read selected event rows and their root privacy authority in one SQL snapshot.
 */
export async function readConversationEventPrivacySnapshot(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    eventTypes: readonly string[];
  },
): Promise<ConversationEventPrivacySnapshot | undefined> {
  const rows = await executor
    .db()
    .select({
      privacy: rootVisibilitySnapshotSql(args.conversationId),
      event: {
        ...conversationEventColumns,
        // Replacement history is model context, never dashboard report data.
        // Keep the required replacement field while redacting its contents.
        payload: sql<Record<string, unknown>>`case
          when ${juniorConversationEvents.type} in ('compaction', 'handoff')
          then jsonb_set(
            ${juniorConversationEvents.payload},
            '{replacementHistory}',
            '[]'::jsonb
          )
          else ${juniorConversationEvents.payload}
        end`,
      },
    })
    .from(juniorConversations)
    .leftJoin(
      juniorConversationEvents,
      and(
        eq(juniorConversationEvents.conversationId, args.conversationId),
        inArray(juniorConversationEvents.type, [...args.eventTypes]),
      ),
    )
    .where(eq(juniorConversations.conversationId, args.conversationId))
    .orderBy(asc(juniorConversationEvents.seq));
  const first = rows[0];
  if (!first) return undefined;

  return {
    ...first.privacy,
    events: rows.flatMap(({ event }) => (event ? [event] : [])),
  };
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

async function readCandidateVisibility(
  executor: JuniorSqlDatabase,
  candidate: LineageCandidate,
): Promise<RootConversationVisibility> {
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
): Promise<RootConversationVisibility> {
  const candidate = await traceLineage(executor, conversationId);
  if (!candidate) {
    return { rootConversationId: conversationId, visibility: null };
  }

  return readCandidateVisibility(executor, candidate);
}
