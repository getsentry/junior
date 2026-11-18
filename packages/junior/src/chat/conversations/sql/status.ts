import { and, desc, eq, gt, gte, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ConversationReportStatus } from "@/api/schema/conversation";
import { reviewItemNeedsInput } from "@/chat/review-items/access";
import { awaitsAuthorization } from "./authorization-wait";
import {
  juniorConversationBriefs,
  juniorConversationEvents,
  juniorConversationReadPositions,
  juniorConversations,
  juniorIdentities,
  juniorReviewItems,
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

const starterRoot = alias(juniorConversations, "status_starter_root");
const starterIdentity = alias(juniorIdentities, "status_starter_identity");
const replyReader = alias(juniorIdentities, "status_reply_reader");

/**
 * SQL: the work of the Conversation waits on its starter. The starter is
 * the User of the root's actor: the person whose message started the root,
 * or the creator of an Automation run. A Task reports to its parent, so
 * only a root, an Automation run, or a Thread waits on its starter. A stop
 * ends what the Conversation waits on, and a queued or running Turn is
 * `working`, not waiting. One of these applies:
 *
 * - The latest Turn failed.
 * - The latest Brief outcome is `partial` or `blocked`.
 * - The latest assistant Message is an answer that the starter has not
 *   read. It is an answer when the latest Brief is `answered` or does not
 *   cover it. A `done` Brief that covers it needs no read. The starter read
 *   it when a root delivered it to its Slack Location, when the starter
 *   wrote a later Message, or when their dashboard read position reaches it.
 */
function conversationWaitsOnStarterSql(
  conversation: ConversationStatusColumns,
): SQL<boolean> {
  const id = conversation.conversationId;
  // Reads `junior_conversation_briefs_conversation_version_idx`.
  const latestBrief = (column: SQL) =>
    sql`(select ${column} from ${juniorConversationBriefs} where ${eq(
      juniorConversationBriefs.conversationId,
      id,
    )} order by ${desc(juniorConversationBriefs.version)} limit 1)`;
  const briefStatus = latestBrief(
    sql`${juniorConversationBriefs.content}->'outcome'->>'status'`,
  );
  const briefThroughSeq = latestBrief(
    sql`${juniorConversationBriefs.throughSeq}`,
  );
  // Transcript order, the order of read positions, is `seq`, not time.
  // Reads `junior_conversation_events_message_role_idx` and sorts the
  // Conversation's assistant Messages by `seq`.
  const replySeq = sql`(select ${juniorConversationEvents.seq} from ${juniorConversationEvents} where ${and(
    eq(juniorConversationEvents.conversationId, id),
    eq(juniorConversationEvents.type, "message"),
    sql`${juniorConversationEvents.payload}->>'role' = 'assistant'`,
  )} order by ${desc(juniorConversationEvents.seq)} limit 1)`;
  const starterUserId = sql`(select ${starterIdentity.userId} from ${juniorConversations} as ${starterRoot} join ${juniorIdentities} as ${starterIdentity} on ${eq(
    starterIdentity.id,
    starterRoot.actorIdentityId,
  )} where ${eq(
    starterRoot.conversationId,
    sql`coalesce(${conversation.rootConversationId}, ${id})`,
  )})`;
  const readByStarter = or(
    and(
      sql`${conversation.parentConversationId} is null`,
      sql`${conversation.location} is not null`,
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
  const unreadAnswer = sql`${replySeq} is not null and (coalesce(${briefStatus}, 'answered') = 'answered' or ${briefThroughSeq} < ${replySeq}) and not (${readByStarter})`;
  return sql<boolean>`(${conversation.stoppedAt} is null
    and coalesce(${conversation.kind}, case when ${conversation.parentConversationId} is null then 'root' else 'task' end) <> 'task'
    and not ${conversationIsActiveSql(conversation)}
    and (
      ${conversationTurnFailedSql(conversation)}
      or ${briefStatus} in ('partial', 'blocked')
      or (${unreadAnswer})
    ))`;
}

/**
 * SQL for the status of one Conversation's own work, shared by everyone.
 * This is the only place that derives it; readers, counts, and feed tokens
 * select it. When more than one applies: `needs_input` > `working` > `done`.
 *
 * - `needs_input`: an open action Review item that this Conversation added
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
  const needsInput = sql`exists (select 1 from ${juniorReviewItems} where ${and(
    eq(juniorReviewItems.addedByConversationId, conversation.conversationId),
    reviewItemNeedsInput(),
  )})`;
  return sql<ConversationReportStatus>`case
    when ${needsInput} or ${awaitsAuthorization(conversation.conversationId)} or ${conversationWaitsOnStarterSql(conversation)} then 'needs_input'
    when ${conversationIsActiveSql(conversation)} then 'working'
    else 'done'
  end`;
}
