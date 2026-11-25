import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import type { JuniorSqlDatabase } from "@/db/db";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { requestAttachmentDeletion } from "@/chat/attachments/store";
import { deleteTodos } from "@/chat/todos/store";
import { dismissOpenInboxItems } from "@/chat/inbox-items/store";
import {
  juniorConversationEvents,
  juniorConversationEmbeddings,
  juniorConversations,
  juniorAgentBindings,
  juniorInboxItems,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import { touchConversationDetail } from "./detail-version";
import { withConversationEventLock } from "./event-lock";
import { deleteMessageLinks } from "./message-links";
import { withConversationMutationLock } from "./store";

// No runtime code reads or writes Agent invocations, but the table stays in
// the database for one release, with its rows and their foreign keys to
// Conversations. Purge still deletes the rows of a purged tree.
// TODO(dcramer): Delete with the migration that drops the table.
const juniorAgentInvocations = pgTable("junior_agent_invocations", {
  parentConversationId: text("parent_conversation_id").notNull(),
  childConversationId: text("child_conversation_id").notNull(),
});

// No runtime code reads legacy Briefs, but the table stays in the database
// for one release. A Brief holds Conversation content, so purge still
// deletes the Briefs of a purged non-public tree.
// TODO(dcramer): Delete with the migration that drops the table.
const juniorConversationBriefs = pgTable("junior_conversation_briefs", {
  conversationId: text("conversation_id").notNull(),
});

/** An expired root conversation selected for purge, with its resolved visibility. */
export interface ExpiredRoot {
  conversationId: string;
  /** Null is private. */
  visibility: ConversationPrivacy | null;
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
  /* oxlint-disable no-await-in-loop -- Each level reads the children of the level before. */
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
  /* oxlint-enable no-await-in-loop */
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
  const cutoff = sql`case when ${juniorConversations.visibility} = 'public' then ${publicCutoff}::timestamptz else ${privateCutoff}::timestamptz end`;
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
      or exists (
        select 1 from junior_inbox_items inbox_items
        where inbox_items.owner_kind = 'conversation'
          and inbox_items.owner_id = tree.conversation_id
          and inbox_items.status = 'open'
          and inbox_items.automation_id is null
      )
      or exists (
        select 1 from junior_todos todos
        where todos.conversation_id = tree.conversation_id
      )
      or exists (
        select 1 from junior_turns turns
        where turns.conversation_id = tree.conversation_id
      )
      or exists (
        select 1 from junior_turn_inbox inbox
        where inbox.conversation_id = tree.conversation_id
      )
      or (
        ${juniorConversations.visibility} is distinct from 'public'
        and (
          exists (
            select 1 from junior_conversation_briefs briefs
            where briefs.conversation_id = tree.conversation_id
          )
          or exists (
            select 1 from junior_conversations metadata
            where metadata.conversation_id = tree.conversation_id
              and metadata.summary is not null
          )
          or exists (
            select 1 from junior_conversation_embeddings embeddings
            where embeddings.conversation_id = tree.conversation_id
          )
          or exists (
            select 1 from junior_inbox_items inbox_items
            where inbox_items.owner_kind = 'conversation'
              and inbox_items.owner_id = tree.conversation_id
              and inbox_items.visibility = 'private'
              and (
                inbox_items.status <> 'open'
                or inbox_items.automation_id is null
              )
          )
          or exists (
            select 1 from junior_conversations metadata
            where metadata.conversation_id = tree.conversation_id
              and (
                metadata.title is not null
                or metadata.channel_name is not null
                or metadata.actor_json is not null
              )
          )
        )
      )
  )`;
  const rows = await executor
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      visibility: juniorConversations.visibility,
    })
    .from(juniorConversations)
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
 * conversations keep only safe metadata. To-dos, Turns, and Turn inputs and
 * deliveries go with the transcript.
 * Non-public content also loses its summary, Conversation embedding, legacy
 * Briefs, and the Inbox items that it added. The metadata rows themselves
 * survive.
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
          /* oxlint-disable no-await-in-loop -- Take event locks in tree order so writers cannot deadlock. */
          for (const conversation of tree.slice(1)) {
            await withConversationEventLock(
              executor,
              conversation.conversationId,
              async () => undefined,
            );
          }
          /* oxlint-enable no-await-in-loop */

          const roots = await executor
            .db()
            .select({
              conversationId: juniorConversations.conversationId,
              parentConversationId: juniorConversations.parentConversationId,
              visibility: juniorConversations.visibility,
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
          // The root row lock keeps its visibility stable. Only a root stores
          // visibility, so a row that is not a root reads as private.
          const isPublic = root.visibility === "public";
          const resolvedScrubMetadata = args.scrubMetadataFromRootVisibility
            ? !isPublic
            : args.scrubMetadata;
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
          // The outbox rows go with their events.
          await executor
            .db()
            .delete(juniorConversationEvents)
            .where(inArray(juniorConversationEvents.conversationId, ids));
          await deleteMessageLinks(executor, ids);
          // Inbox rows hold message text. They refer to Turns, so they go first.
          await executor
            .db()
            .delete(juniorTurnInbox)
            .where(inArray(juniorTurnInbox.conversationId, ids));
          await executor
            .db()
            .delete(juniorTurns)
            .where(inArray(juniorTurns.conversationId, ids));
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
          // No agent can act on an item after its Conversation is purged.
          await dismissOpenInboxItems(executor.db(), {
            ownerConversationIds: ids,
            nowMs: args.nowMs,
            reason: "Conversation purged",
          });
          // To-dos hold titles and notes from the transcript.
          await deleteTodos(executor, ids);
          await requestAttachmentDeletion(executor, ids, args.nowMs);
          const scrubMetadata = args.retention
            ? !isPublic
            : resolvedScrubMetadata;
          // Clear the metadata before the embedding delete. The update locks
          // each Conversation row, so an embedding write that holds a share
          // lock commits first and is deleted below, and a later one finds
          // no metadata. See `writeConversationEmbeddings`.
          await executor
            .db()
            .update(juniorConversations)
            .set({
              transcriptPurgedAt: new Date(args.nowMs),
              ...(scrubMetadata
                ? {
                    title: null,
                    channelName: null,
                    actor: null,
                    summary: null,
                    metadataThroughSeq: null,
                  }
                : undefined),
            })
            .where(inArray(juniorConversations.conversationId, ids));
          if (scrubMetadata) {
            await executor
              .db()
              .delete(juniorConversationBriefs)
              .where(inArray(juniorConversationBriefs.conversationId, ids));
            await executor
              .db()
              .delete(juniorConversationEmbeddings)
              .where(inArray(juniorConversationEmbeddings.conversationId, ids));
            // A private Inbox item holds content from its Conversation. A
            // public item stays, even when its destination later turned
            // private, because other Conversations can still link to it. An
            // open item of an Automation also stays, because a later run can
            // still change it. A later purge deletes it after it closes.
            await executor
              .db()
              .delete(juniorInboxItems)
              .where(
                and(
                  eq(juniorInboxItems.ownerKind, "conversation"),
                  inArray(juniorInboxItems.ownerId, ids),
                  eq(juniorInboxItems.visibility, "private"),
                  or(
                    ne(juniorInboxItems.status, "open"),
                    isNull(juniorInboxItems.automationId),
                  ),
                ),
              );
          }
          await touchConversationDetail(executor.db(), ids);
          return { purged: true, conversations: ids.length };
        },
      );
    },
  );
}
