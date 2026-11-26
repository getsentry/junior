import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { EndedTurn } from "@/chat/conversations/turn-update";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import {
  inboxItemNeedsInput,
  inboxItemOwnedByConversation,
  inboxItemSetsConversationStatus,
} from "@/chat/inbox-items/access";
import { awaitsAuthorization } from "./authorization-wait";
import { conversationKindSql } from "./conversation-row";
import {
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
  juniorInboxItems,
} from "@/db/schema";

/** The `junior_conversations` columns, or an alias's, that status reads. */
export interface ConversationStatusColumns {
  conversationId: AnyPgColumn;
  executionStatus: AnyPgColumn;
  kind: AnyPgColumn;
  location: AnyPgColumn;
  parentConversationId: AnyPgColumn;
  stoppedAt: AnyPgColumn;
}

// Execution is pending, running, or paused for another execution slice.
// TODO(dcramer): Drop awaiting_resume with the store reader's alias for it.
const ACTIVE_EXECUTION_STATUSES = [
  "pending",
  "running",
  "paused",
  "awaiting_resume",
];

/** SQL: a Turn of the Conversation is queued or running. */
export function conversationIsActiveSql(
  conversation: Pick<ConversationStatusColumns, "executionStatus">,
): SQL<boolean> {
  return sql<boolean>`${conversation.executionStatus} in (${sql.raw(
    ACTIVE_EXECUTION_STATUSES.map((status) => `'${status}'`).join(", "),
  )})`;
}

/**
 * Whether a Turn is queued or running, for a row that is already read. It
 * matches `conversationIsActiveSql`. Live views poll on it; `status` can
 * read `needs_input` meanwhile.
 */
export function executionIsActive(executionStatus: string): boolean {
  return ACTIVE_EXECUTION_STATUSES.includes(executionStatus);
}

const turnAfterFailure = alias(
  juniorConversationEvents,
  "status_turn_after_failure",
);

/**
 * SQL: the latest Turn of the Conversation failed with no newer input.
 * Execution is `failed`, or the newest Turn lifecycle Event is
 * `turn_failed`. Events are durable; the Redis Turn record expires. Stats
 * count it; the status reads it as input that the starter needs to give.
 */
export function conversationTurnFailedSql(
  conversation: Pick<
    ConversationStatusColumns,
    "conversationId" | "executionStatus"
  >,
): SQL<boolean> {
  // Each read is one end of
  // `junior_conversation_events_type_idx (conversation_id, type, seq)`.
  // Most Conversations have no failed Turn, so the read of the newest one
  // finds nothing, and the check for a later Turn does not run.
  return sql<boolean>`(${conversation.executionStatus} = 'failed' or coalesce((
    select not exists (
      select 1 from ${juniorConversationEvents} as ${turnAfterFailure}
      where ${turnAfterFailure.conversationId} = ${juniorConversationEvents.conversationId}
        and ${turnAfterFailure.type} in ('turn_started', 'turn_completed')
        and ${turnAfterFailure.seq} > ${juniorConversationEvents.seq}
    )
    from ${juniorConversationEvents}
    where ${and(
      eq(juniorConversationEvents.conversationId, conversation.conversationId),
      eq(juniorConversationEvents.type, "turn_failed"),
    )}
    order by ${desc(juniorConversationEvents.seq)}
    limit 1
  ), false))`;
}

/**
 * SQL: how the Conversation's newest finished Turn that was not stopped
 * ended: the `turn_completed` outcome, or `failed` for `turn_failed`. A
 * stop is not a result, so a cancelled Turn is skipped. Null when no Turn
 * finished. Unlike `conversationTurnFailedSql`, a later Turn does not clear
 * a failure until it finishes.
 */
export function conversationLastTurnOutcomeSql(
  conversation: Pick<ConversationStatusColumns, "conversationId">,
): SQL<EndedTurn["outcome"] | "failed" | null> {
  return sql<
    EndedTurn["outcome"] | "failed" | null
  >`(select case when ${juniorConversationEvents.type} = 'turn_failed' then 'failed' else ${juniorConversationEvents.payload}->>'outcome' end from ${juniorConversationEvents} where ${and(
    eq(juniorConversationEvents.conversationId, conversation.conversationId),
    inArray(juniorConversationEvents.type, ["turn_completed", "turn_failed"]),
  )} and coalesce(${juniorConversationEvents.payload}->>'outcome', '') <> 'cancelled' order by ${juniorConversationEvents.seq} desc limit 1)`;
}

// When #3050 merged; its deploy came later, so no reply before this was
// held back by a delivery pause.
const DELIVERY_PAUSE_START = sql.raw(`'2026-11-10T02:48:39Z'::timestamptz`);

const starterRoot = alias(juniorConversations, "status_starter_root");
const starterIdentity = alias(juniorIdentities, "status_starter_identity");
const replyReader = alias(juniorIdentities, "status_reply_reader");

/** SQL: the Conversation with this id is a Lead. */
function isLeadSql(conversationId: SQL | AnyPgColumn): SQL<boolean> {
  return sql<boolean>`exists (select 1 from junior_conversations status_lead where status_lead.conversation_id = ${conversationId} and status_lead.kind = 'lead')`;
}

/**
 * SQL: the id of the Conversation's Top-level Conversation: itself or the
 * nearest ancestor with no parent or with a Lead as its parent. A Lead is
 * the root of every Conversation in its Space, so the root alone would make
 * the Lead's actor the starter of all Space work.
 */
function conversationTopLevelIdSql(
  conversation: ConversationStatusColumns,
): SQL<string> {
  // The walk goes up one parent at a time and stops at a Top-level
  // Conversation. UNION, not UNION ALL, so that bad parent links cannot
  // loop forever; such a loop has no Top-level Conversation.
  const ancestorParent = sql`status_ancestor.parent_conversation_id`;
  return sql<string>`(case when ${conversation.parentConversationId} is null then ${conversation.conversationId} else (
    with recursive status_ancestor(conversation_id, parent_conversation_id) as (
      select ${conversation.conversationId}::text, ${conversation.parentConversationId}::text
      union
      select parent.conversation_id, parent.parent_conversation_id
      from status_ancestor
      join junior_conversations parent on parent.conversation_id = ${ancestorParent}
      where not ${isLeadSql(ancestorParent)}
    )
    select conversation_id from status_ancestor
    where ${ancestorParent} is null or ${isLeadSql(ancestorParent)}
    limit 1
  ) end)`;
}

/**
 * SQL: the User id of the Conversation's starter, the User of its
 * Top-level Conversation's actor.
 */
function conversationStarterUserIdSql(
  conversation: ConversationStatusColumns,
): SQL {
  return sql`(select ${starterIdentity.userId} from ${juniorConversations} as ${starterRoot} join ${juniorIdentities} as ${starterIdentity} on ${eq(
    starterIdentity.id,
    starterRoot.actorIdentityId,
  )} where ${eq(starterRoot.conversationId, conversationTopLevelIdSql(conversation))})`;
}

/**
 * SQL: the work of the Conversation waits on its starter. The starter is
 * the User of its Top-level Conversation's actor: the person whose message
 * started it, or the creator of an Automation run. A Task reports to its
 * parent, so only a root, an Automation run, or a Thread waits on its
 * starter. A stop
 * ends what the Conversation waits on, and a queued or running Turn is
 * `working`, not waiting. One of these applies:
 *
 * - The latest Turn failed.
 * - The starter has not read the latest assistant Message. The starter read
 *   it when Slack accepted it for a Top-level Conversation's Location, when
 *   the starter wrote a later Message, or when their dashboard read
 *   position reaches it.
 *   With no starter, nobody reads it, so an answer does not wait.
 */
function conversationWaitsOnStarterSql(
  conversation: ConversationStatusColumns,
): SQL<boolean> {
  const id = conversation.conversationId;
  // Postgres runs a subquery each place that names it, so each fact below
  // is read once, in one row, and the rule reads it by name. `offset 0`
  // keeps Postgres from copying the starter lookup back into each use.
  const starter = sql.identifier("status_starter");
  const reply = sql.identifier("status_reply");
  const starterUserId = sql`${starter}.user_id`;
  const replySeq = sql`${reply}.seq`;
  const replyInSlack = sql`${reply}.in_slack`;
  // Transcript order, the order of read positions, is `seq`, not time.
  // Reads the newest entry of `junior_conversation_events_message_role_seq_idx`.
  // The type is a literal: a generic plan can use the partial index only
  // when the query states its predicate.
  // A reply has source `slack` only when Slack accepted it. A reply that a
  // delivery pause held back has no source and no other mark. Pauses started
  // with #3050, so a reply with no source from before then reached Slack.
  // TODO(dcramer): Drop the date once no root's latest reply predates it.
  const latestReply = sql`(select ${juniorConversationEvents.seq} as seq, coalesce(${juniorConversationEvents.payload}->'meta'->>'source' = 'slack', ${juniorConversationEvents.createdAt} < ${DELIVERY_PAUSE_START}) as in_slack from ${juniorConversationEvents} where ${and(
    eq(juniorConversationEvents.conversationId, id),
    sql`${juniorConversationEvents.type} = 'message'`,
    sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
  )} order by ${desc(juniorConversationEvents.seq)} limit 1)`;
  const readByStarter = or(
    and(
      // Only a Top-level Conversation delivers to its Location. A child
      // copies its parent's Location but does not deliver to it.
      sql`(${conversation.parentConversationId} is null or ${isLeadSql(conversation.parentConversationId)})`,
      sql`${conversation.location} is not null`,
      // No reply must read false: `not (null)` is null, not true.
      sql`coalesce(${replyInSlack}, false)`,
    ),
    sql`exists (select 1 from ${juniorConversationEvents} join ${juniorIdentities} as ${replyReader} on ${eq(
      replyReader.id,
      juniorConversationEvents.actorIdentityId,
    )} where ${and(
      eq(juniorConversationEvents.conversationId, id),
      eq(juniorConversationEvents.type, "message"),
      gt(juniorConversationEvents.seq, replySeq),
      eq(replyReader.userId, starterUserId),
    )})`,
    sql`exists (select 1 from ${juniorConversationReadPositions} where ${and(
      eq(juniorConversationReadPositions.conversationId, id),
      eq(juniorConversationReadPositions.userId, starterUserId),
      gte(juniorConversationReadPositions.lastReadSeq, replySeq),
    )})`,
  );
  // With no starter, nobody can read the answer, so nothing waits on it.
  const waitsOnFacts = sql`(select ${replySeq} is not null and ${starterUserId} is not null and not (${readByStarter})
    from (select ${conversationStarterUserIdSql(conversation)} as user_id offset 0) as ${starter}
    left join lateral ${latestReply} as ${reply} on true)`;
  return sql<boolean>`(${conversation.stoppedAt} is null
    and ${conversationKindSql(conversation)} <> 'task'
    and not ${conversationIsActiveSql(conversation)}
    and (
      ${conversationTurnFailedSql(conversation)}
      or ${waitsOnFacts}
    ))`;
}

/**
 * SQL for the status of one Conversation's own work, shared by everyone.
 * This is the only place that derives it; readers, counts, and feed tokens
 * select it. When more than one applies: `needs_input` > `working` > `done`.
 *
 * - `needs_input`: an open action Inbox item that this Conversation added
 *   waits on its assignees or Everyone, a Turn waits on a person to sign in
 *   (`awaitsAuthorization`), or the work waits on its starter
 *   (`conversationWaitsOnStarterSql`).
 * - `working`: a Turn is queued or running (`conversationIsActiveSql`).
 * - `done`: anything else, such as a read answer, a stop, or an idle
 *   Conversation.
 */
export function conversationStatusSql(
  conversation: ConversationStatusColumns,
): SQL<ConversationReportStatus> {
  const needsInput = sql`exists (select 1 from ${juniorInboxItems} where ${and(
    inboxItemOwnedByConversation(conversation.conversationId),
    inboxItemNeedsInput(),
    inboxItemSetsConversationStatus(),
  )})`;
  return sql<ConversationReportStatus>`case
    when ${needsInput} or ${awaitsAuthorization(conversation.conversationId)} or ${conversationWaitsOnStarterSql(conversation)} then 'needs_input'
    when ${conversationIsActiveSql(conversation)} then 'working'
    else 'done'
  end`;
}

/**
 * SQL: the Conversation's work waits on this User as its starter. See
 * `conversationWaitsOnStarterSql`.
 */
export function conversationWaitsOnUserSql(
  conversation: ConversationStatusColumns,
  userId: string,
): SQL<boolean> {
  return sql<boolean>`(${conversationStarterUserIdSql(conversation)} = ${userId} and ${conversationWaitsOnStarterSql(conversation)})`;
}
