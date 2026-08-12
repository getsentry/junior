import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { JuniorSqlDatabase } from "@/db/db";
import type { JuniorDestinationVisibility } from "@/db/schema/destinations";
import { requestAttachmentDeletion } from "@/chat/attachments/store";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorDestinations,
  juniorAgentBindings,
  juniorAgentInvocations,
} from "@/db/schema";
import { withConversationEventLock } from "./event-lock";
import { resolveRootVisibility } from "./privacy";
import { withConversationMutationLock } from "./store";

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

interface ConversationTreeRow {
  conversationId: string;
  parentConversationId: string | null;
}

/** Discover a root and its current descendants via `parent_conversation_id`. */
async function discoverConversationTree(
  executor: JuniorSqlDatabase,
  root: ConversationTreeRow,
): Promise<ConversationTreeRow[]> {
  const all = new Map<string, ConversationTreeRow>([
    [root.conversationId, root],
  ]);
  let frontier = [root.conversationId];
  while (frontier.length > 0) {
    const children = await executor
      .db()
      .select({
        conversationId: juniorConversations.conversationId,
        parentConversationId: juniorConversations.parentConversationId,
      })
      .from(juniorConversations)
      .where(inArray(juniorConversations.parentConversationId, frontier))
      .orderBy(asc(juniorConversations.conversationId));
    frontier = [];
    for (const child of children) {
      if (!all.has(child.conversationId)) {
        all.set(child.conversationId, child);
        frontier.push(child.conversationId);
      }
    }
  }
  return [...all.values()];
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
  const effectiveLastActivityAt = sql<Date>`(
    with recursive conversation_tree(conversation_id, last_activity_at) as (
      select ${juniorConversations.conversationId}, ${juniorConversations.lastActivityAt}
      union all
      select child.conversation_id, child.last_activity_at
      from junior_conversations child
      join conversation_tree parent on child.parent_conversation_id = parent.conversation_id
    )
    select max(tree.last_activity_at) from conversation_tree tree
  )`;
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
      select 1 from junior_conversation_events events
      where events.conversation_id = tree.conversation_id
    )
      or exists (
        select 1 from junior_agent_invocations invocations
        where invocations.parent_conversation_id = tree.conversation_id
           or invocations.child_conversation_id = tree.conversation_id
      )
      or exists (
        select 1 from junior_agent_bindings bindings
        where bindings.parent_conversation_id = tree.conversation_id
           or bindings.child_conversation_id = tree.conversation_id
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
        sql`${effectiveLastActivityAt} < ${cutoff}`,
        hasTreeWork,
      ),
    )
    .orderBy(
      asc(effectiveLastActivityAt),
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
 * event rows for the given conversation and every descendant, stamp
 * `transcript_purged_at`, and — for non-public content — null the raw-payload
 * metadata (`title`, `channel_name`, legacy actor JSON) so purged private
 * conversations keep only safe metadata. The metadata rows themselves survive.
 */
export async function purgeConversationTree(
  executor: JuniorSqlDatabase,
  args: {
    rootConversationId: string;
    scrubMetadata?: boolean;
    scrubMetadataFromRootVisibility?: boolean;
    nowMs: number;
    retention?: { privateWindowMs: number; publicWindowMs: number };
  },
): Promise<PurgeTreeResult> {
  return await withConversationMutationLock(
    executor,
    args.rootConversationId,
    async () => {
      const initialRoots = await executor
        .db()
        .select({
          conversationId: juniorConversations.conversationId,
          parentConversationId: juniorConversations.parentConversationId,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, args.rootConversationId));
      const initialRoot = initialRoots[0];
      if (
        !initialRoot ||
        (args.retention && initialRoot.parentConversationId !== null)
      ) {
        return { purged: false, conversations: 0 };
      }
      const tree = await discoverConversationTree(executor, initialRoot);

      return await withConversationEventLock(
        executor,
        args.rootConversationId,
        async () => {
          // Parent links are immutable, and the root mutation lock prevents live
          // child creation after discovery. Acquire every event lock before row
          // locks so a child writer can finish without deadlocking on its parent
          // relationship.
          for (const conversation of tree.slice(1)) {
            await withConversationEventLock(
              executor,
              conversation.conversationId,
              async () => undefined,
            );
          }

          const roots = await executor
            .db()
            .select({
              conversationId: juniorConversations.conversationId,
              destinationId: juniorConversations.destinationId,
              parentConversationId: juniorConversations.parentConversationId,
            })
            .from(juniorConversations)
            .where(
              eq(juniorConversations.conversationId, args.rootConversationId),
            )
            .for("update");
          const root = roots[0];
          if (!root || (args.retention && root.parentConversationId !== null)) {
            return { purged: false, conversations: 0 };
          }
          const resolvedScrubMetadata = args.scrubMetadataFromRootVisibility
            ? (await resolveRootVisibility(executor, args.rootConversationId))
                .visibility !== "public"
            : args.scrubMetadata;
          const destinations = root.destinationId
            ? await executor
                .db()
                .select({ visibility: juniorDestinations.visibility })
                .from(juniorDestinations)
                .where(eq(juniorDestinations.id, root.destinationId))
                .for("share")
            : [];
          const isPublic = destinations[0]?.visibility === "public";
          const ids = tree.map((conversation) => conversation.conversationId);
          if (args.retention) {
            const currentActivity = await executor
              .db()
              .select({
                conversationId: juniorConversations.conversationId,
                lastActivityAt: juniorConversations.lastActivityAt,
              })
              .from(juniorConversations)
              .where(inArray(juniorConversations.conversationId, ids));
            if (currentActivity.length !== ids.length) {
              return { purged: false, conversations: 0 };
            }
            const windowMs = isPublic
              ? args.retention.publicWindowMs
              : args.retention.privateWindowMs;
            const effectiveLastActivityAt = Math.max(
              ...currentActivity.map((conversation) =>
                conversation.lastActivityAt.getTime(),
              ),
            );
            if (effectiveLastActivityAt >= args.nowMs - windowMs) {
              return { purged: false, conversations: 0 };
            }
          }
          await executor
            .db()
            .delete(juniorConversationEvents)
            .where(inArray(juniorConversationEvents.conversationId, ids));
          await executor
            .db()
            .delete(juniorAgentInvocations)
            .where(
              or(
                inArray(juniorAgentInvocations.parentConversationId, ids),
                inArray(juniorAgentInvocations.childConversationId, ids),
              ),
            );
          await executor
            .db()
            .delete(juniorAgentBindings)
            .where(
              or(
                inArray(juniorAgentBindings.parentConversationId, ids),
                inArray(juniorAgentBindings.childConversationId, ids),
              ),
            );
          await requestAttachmentDeletion(executor, ids, args.nowMs);
          await executor
            .db()
            .update(juniorConversations)
            .set({
              transcriptPurgedAt: new Date(args.nowMs),
              ...((args.retention ? !isPublic : resolvedScrubMetadata)
                ? { title: null, channelName: null, actor: null }
                : {}),
            })
            .where(inArray(juniorConversations.conversationId, ids));
          return { purged: true, conversations: ids.length };
        },
      );
    },
  );
}
