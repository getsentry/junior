import { and, desc, eq, gt, gte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import {
  inboxItemNeedsInput,
  inboxItemOwnedByConversation,
} from "@/chat/inbox-items/access";
import { INBOX_SUBJECT_KINDS } from "@/chat/inbox-items/subjects";
import { awaitsAuthorization } from "./authorization-wait";
import { conversationKindSql } from "./conversation-row";
import {
  juniorConversationBriefs,
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
  rootConversationId: AnyPgColumn;
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
  // One max per type, so each reads the end of
  // `junior_conversation_events_type_idx (conversation_id, type, seq)`.
  const newestSeq = (type: string) =>
    sql`(select max(${juniorConversationEvents.seq}) from ${juniorConversationEvents} where ${and(
      eq(juniorConversationEvents.conversationId, conversation.conversationId),
      eq(juniorConversationEvents.type, type),
    )})`;
  // greatest() skips nulls; a Conversation with no started Turn reads -1.
  return sql<boolean>`(${conversation.executionStatus} = 'failed' or ${newestSeq("turn_failed")} > coalesce(greatest(${newestSeq("turn_started")}, ${newestSeq("turn_completed")}), -1))`;
}

// When #3050 merged; its deploy came later, so no reply before this was
// held back by a delivery pause.
const DELIVERY_PAUSE_START = sql.raw(`'2026-11-10T02:48:39Z'::timestamptz`);

const starterRoot = alias(juniorConversations, "status_starter_root");
const starterIdentity = alias(juniorIdentities, "status_starter_identity");
const replyReader = alias(juniorIdentities, "status_reply_reader");

/** SQL: the User id of the Conversation's starter, the User of its root's actor. */
function conversationStarterUserIdSql(
  conversation: ConversationStatusColumns,
): SQL {
  return sql`(select ${starterIdentity.userId} from ${juniorConversations} as ${starterRoot} join ${juniorIdentities} as ${starterIdentity} on ${eq(
    starterIdentity.id,
    starterRoot.actorIdentityId,
  )} where ${eq(
    starterRoot.conversationId,
    sql`coalesce(${conversation.rootConversationId}, ${conversation.conversationId})`,
  )})`;
}

/**
 * SQL: the work of the Conversation waits on its starter. The starter is
 * the User of the root's actor: the person whose message started the root,
 * or the creator of an Automation run. A Task reports to its parent, so
 * only a root, an Automation run, or a Thread waits on its starter. A stop
 * ends what the Conversation waits on, and a queued or running Turn is
 * `working`, not waiting. One of these applies:
 *
 * - The latest Turn failed.
 * - The latest Brief outcome is `partial` or `blocked`, and that Brief
 *   covers the latest assistant Message. Turns no longer store Briefs, so a
 *   legacy Brief stops deciding once the Conversation moves on.
 * - The latest assistant Message is an answer that the starter has not
 *   read. It is an answer when the latest Brief is `answered` or does not
 *   cover it. A `done` Brief that covers it needs no read. The starter read
 *   it when Slack accepted it for a root's Location, when the starter
 *   wrote a later Message, or when their dashboard read position reaches it.
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
  const brief = sql.identifier("status_brief");
  const reply = sql.identifier("status_reply");
  const starterUserId = sql`${starter}.user_id`;
  const briefStatus = sql`${brief}.status`;
  const briefThroughSeq = sql`${brief}.through_seq`;
  const replySeq = sql`${reply}.seq`;
  const replyInSlack = sql`${reply}.in_slack`;
  // Reads `junior_conversation_briefs_conversation_version_idx`.
  const latestBrief = sql`(select ${juniorConversationBriefs.content}->'outcome'->>'status' as status, ${juniorConversationBriefs.throughSeq} as through_seq from ${juniorConversationBriefs} where ${eq(
    juniorConversationBriefs.conversationId,
    id,
  )} order by ${desc(juniorConversationBriefs.version)} limit 1)`;
  // Transcript order, the order of read positions, is `seq`, not time.
  // Reads `junior_conversation_events_message_role_idx` and sorts the
  // Conversation's assistant Messages by `seq`.
  // A reply has source `slack` only when Slack accepted it. A reply that a
  // delivery pause held back has no source and no other mark. Pauses started
  // with #3050, so a reply with no source from before then reached Slack.
  // TODO(dcramer): Drop the date once no root's latest reply predates it.
  const latestReply = sql`(select ${juniorConversationEvents.seq} as seq, coalesce(${juniorConversationEvents.payload}->'meta'->>'source' = 'slack', ${juniorConversationEvents.createdAt} < ${DELIVERY_PAUSE_START}) as in_slack from ${juniorConversationEvents} where ${and(
    eq(juniorConversationEvents.conversationId, id),
    eq(juniorConversationEvents.type, "message"),
    sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
  )} order by ${desc(juniorConversationEvents.seq)} limit 1)`;
  const readByStarter = or(
    and(
      sql`${conversation.parentConversationId} is null`,
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
  const unreadAnswer = sql`${replySeq} is not null and ${starterUserId} is not null and (coalesce(${briefStatus}, 'answered') = 'answered' or ${briefThroughSeq} < ${replySeq}) and not (${readByStarter})`;
  const waitsOnFacts = sql`(select (${briefStatus} in ('partial', 'blocked') and (${replySeq} is null or ${briefThroughSeq} >= ${replySeq})) or (${unreadAnswer})
    from (select ${conversationStarterUserIdSql(conversation)} as user_id offset 0) as ${starter}
    left join lateral ${latestBrief} as ${brief} on true
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
 * - `done`: anything else, such as a `done` Brief, a read answer, a stop,
 *   or an idle Conversation.
 */
export function conversationStatusSql(
  conversation: ConversationStatusColumns,
): SQL<ConversationReportStatus> {
  // A To-do's item waits only on its assignee, so it shows only to them,
  // through their tree state and Inbox. It does not change this status.
  const needsInput = sql`exists (select 1 from ${juniorInboxItems} where ${and(
    inboxItemOwnedByConversation(conversation.conversationId),
    inboxItemNeedsInput(),
    ne(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.todo),
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
