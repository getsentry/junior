import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorAgentSteps,
  juniorConversationMessages,
  juniorConversations,
  juniorDestinations,
} from "@/db/schema";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";

/** An expired root conversation selected for purge, with its resolved visibility. */
export interface ExpiredRoot {
  conversationId: string;
  visibility: JuniorDestinationVisibility | null;
}

/** Outcome of purging one conversation tree. */
export interface PurgeTreeResult {
  /** Whether this transaction still found the root eligible for purge. */
  purged: boolean;
  /** Root plus descendant conversation rows stamped by the purge. */
  conversations: number;
}

/** Collect a conversation and every descendant via `parent_conversation_id`. */
async function conversationTreeIds(
  executor: JuniorSqlDatabase,
  rootConversationId: string,
): Promise<string[]> {
  const all = new Set<string>([rootConversationId]);
  let frontier = [rootConversationId];
  while (frontier.length > 0) {
    const children = await executor
      .db()
      .select({ id: juniorConversations.conversationId })
      .from(juniorConversations)
      .where(inArray(juniorConversations.parentConversationId, frontier));
    frontier = [];
    for (const child of children) {
      if (!all.has(child.id)) {
        all.add(child.id);
        frontier.push(child.id);
      }
    }
  }
  return [...all];
}

/**
 * Select expired root conversations for purge, oldest activity first.
 *
 * Roots have no parent, so visibility is read directly from the root's own
 * destination; the private window applies to every non-`public` case. A row is
 * skipped once it is fully purged — no content rows survive and no non-public
 * scrub fields remain — so a bounded batch spends its budget on real work.
 */
export async function selectExpiredRoots(
  executor: JuniorSqlDatabase,
  args: {
    nowMs: number;
    publicWindowMs: number;
    privateWindowMs: number;
    limit: number;
  },
): Promise<ExpiredRoot[]> {
  const publicCutoff = new Date(args.nowMs - args.publicWindowMs).toISOString();
  const privateCutoff = new Date(
    args.nowMs - args.privateWindowMs,
  ).toISOString();
  const cutoff = sql`case when ${juniorDestinations.visibility} = 'public' then ${publicCutoff}::timestamptz else ${privateCutoff}::timestamptz end`;
  const hasTreeWork = sql`exists (
    with recursive conversation_tree(conversation_id) as (
      select ${juniorConversations.conversationId}
      union all
      select child.conversation_id
      from junior_conversations child
      join conversation_tree parent on child.parent_conversation_id = parent.conversation_id
    )
    select 1
    from conversation_tree tree
    where exists (
      select 1 from junior_agent_steps steps
      where steps.conversation_id = tree.conversation_id
    )
      or exists (
        select 1 from junior_conversation_messages messages
        where messages.conversation_id = tree.conversation_id
      )
      or (
        ${juniorDestinations.visibility} is distinct from 'public'
        and exists (
          select 1 from junior_conversations metadata
          where metadata.conversation_id = tree.conversation_id
            and (
              metadata.title is not null
              or metadata.channel_name is not null
              or metadata.actor_json is not null
            )
        )
      )
  )`;
  const rows = await executor
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      visibility: juniorDestinations.visibility,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        sql`${juniorConversations.lastActivityAt} < ${cutoff}`,
        hasTreeWork,
      ),
    )
    .orderBy(
      asc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(Math.max(0, args.limit));
  return rows.map((row) => ({
    conversationId: row.conversationId,
    visibility: row.visibility,
  }));
}

/**
 * Purge one conversation tree in a single transaction: delete all message and
 * step rows for the given conversation and every descendant, stamp
 * `transcript_purged_at`, and — for non-public content — null the raw-payload
 * metadata (`title`, `channel_name`, legacy actor JSON) so purged private
 * conversations keep only safe metadata. The metadata rows themselves survive.
 */
export async function purgeConversationTree(
  executor: JuniorSqlDatabase,
  args: {
    rootConversationId: string;
    scrubMetadata?: boolean;
    nowMs: number;
    retention?: { privateWindowMs: number; publicWindowMs: number };
  },
): Promise<PurgeTreeResult> {
  return await executor.transaction(async () => {
    const roots = await executor
      .db()
      .select({
        destinationId: juniorConversations.destinationId,
        lastActivityAt: juniorConversations.lastActivityAt,
        parentConversationId: juniorConversations.parentConversationId,
      })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, args.rootConversationId))
      .for("update");
    const root = roots[0];
    if (!root || (args.retention && root.parentConversationId !== null)) {
      return { purged: false, conversations: 0 };
    }
    const destinations = root.destinationId
      ? await executor
          .db()
          .select({ visibility: juniorDestinations.visibility })
          .from(juniorDestinations)
          .where(eq(juniorDestinations.id, root.destinationId))
      : [];
    const isPublic = destinations[0]?.visibility === "public";
    if (args.retention) {
      const windowMs = isPublic
        ? args.retention.publicWindowMs
        : args.retention.privateWindowMs;
      if (root.lastActivityAt.getTime() >= args.nowMs - windowMs) {
        return { purged: false, conversations: 0 };
      }
    }
    const ids = await conversationTreeIds(executor, args.rootConversationId);
    await executor
      .db()
      .delete(juniorAgentSteps)
      .where(inArray(juniorAgentSteps.conversationId, ids));
    await executor
      .db()
      .delete(juniorConversationMessages)
      .where(inArray(juniorConversationMessages.conversationId, ids));
    await executor
      .db()
      .update(juniorConversations)
      .set({
        transcriptPurgedAt: new Date(args.nowMs),
        ...((args.retention ? !isPublic : args.scrubMetadata)
          ? { title: null, channelName: null, actor: null }
          : {}),
      })
      .where(inArray(juniorConversations.conversationId, ids));
    return { purged: true, conversations: ids.length };
  });
}

/**
 * Walk `parent_conversation_id` to the root and return the root's destination
 * visibility. Retention resolves visibility at purge time rather than storing an
 * expiry, so a public↔private flip takes effect on the next pass.
 */
export async function resolveRootVisibility(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<{
  rootConversationId: string;
  visibility: JuniorDestinationVisibility | null;
}> {
  let currentId = conversationId;
  const seen = new Set<string>();
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const rows = await executor
      .db()
      .select({
        parentId: juniorConversations.parentConversationId,
        visibility: juniorDestinations.visibility,
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(eq(juniorConversations.conversationId, currentId));
    const row = rows[0];
    if (!row) {
      return { rootConversationId: currentId, visibility: null };
    }
    if (!row.parentId) {
      return { rootConversationId: currentId, visibility: row.visibility };
    }
    currentId = row.parentId;
  }
  return { rootConversationId: currentId, visibility: null };
}
