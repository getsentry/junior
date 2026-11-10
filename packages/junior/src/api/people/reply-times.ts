import type { User } from "@sentry/junior-plugin-api";
import { parseActor } from "@/chat/actor";
import {
  IDLE_HORIZON_MS,
  gapHistogramReport,
  TURN_DEPTHS,
} from "@/chat/cache-warming/model";
import {
  loadReplayEventBatches,
  replayConversation,
} from "@/chat/cache-warming/replay";
import { conversationKindFromRow } from "@/chat/conversations/sql/conversation-row";
import type { ConversationKind } from "@/chat/conversations/store";
import { getSqlExecutor } from "@/chat/db";
import { findUserByEmail, readActorIdentity } from "@/chat/plugins/viewer";
import {
  personReplyTimesReportSchema,
  type PersonReplyTimesReport,
} from "../schema/reply-times";

const DAY_MS = 24 * 60 * 60_000;
// One read replays at most this many of the person's most recent
// Conversations, so a busy person does not make one slow request.
const MAX_CONVERSATIONS = 200;

interface ConversationRow {
  conversationId: string;
  kind: ConversationKind | null;
  parentConversationId: string | null;
}

// Conversations in which the person ran a Turn in the range, newest first.
async function loadPersonConversations(
  identityIds: string[],
  startMs: number,
): Promise<ConversationRow[]> {
  return await getSqlExecutor().query<ConversationRow>(
    `SELECT c.conversation_id AS "conversationId", c.kind,
       c.parent_conversation_id AS "parentConversationId"
     FROM (
       SELECT m.conversation_id, max(m.occurred_at) AS last_turn_at
       FROM junior_conversation_metrics m
       WHERE m.actor_identity_id = ANY($1::text[]) AND m.occurred_at >= $2
       GROUP BY m.conversation_id
       ORDER BY last_turn_at DESC
       LIMIT $3
     ) turns
     JOIN junior_conversations c ON c.conversation_id = turns.conversation_id
     WHERE c.transcript_purged_at IS NULL`,
    [identityIds, new Date(startMs).toISOString(), MAX_CONVERSATIONS],
  );
}

/**
 * Read the reply times of one person: the gaps of idle periods that ended
 * with an instruction of this person. Only the person may read them, so this
 * returns undefined for any other viewer.
 *
 * The gaps come from the stored model calls, with the rules that the cache
 * warming backfill uses. So they use the same bins as the segment gaps, and
 * the two can be compared.
 */
export async function readPersonReplyTimes(args: {
  days: number;
  email: string;
  viewer: User;
}): Promise<PersonReplyTimesReport | undefined> {
  const subject = await findUserByEmail(args.email);
  if (!subject || subject.id !== args.viewer.id) return undefined;
  const nowMs = Date.now();
  const startMs = nowMs - args.days * DAY_MS;
  const conversations = await loadPersonConversations(
    subject.identities.map((identity) => identity.id),
    startMs,
  );
  // An idle period that ends in the range can start before it.
  const { canceledBatches, events } = await loadReplayEventBatches(
    conversations.map((row) => row.conversationId),
    { sinceMs: startMs - IDLE_HORIZON_MS },
  );
  const gaps = conversations.flatMap((conversation) =>
    replayConversation(
      conversationKindFromRow(conversation),
      events.get(conversation.conversationId) ?? [],
      nowMs,
    ).filter((gap) => gap.sinceMs >= startMs && gap.replyActor),
  );
  // Resolve each stored Actor once. Display fields can differ between
  // instructions of one person, but they resolve to the same User.
  const isSubject = new Map<string, Promise<boolean>>();
  const repliedBySubject = (actor: unknown) => {
    const key = JSON.stringify(actor);
    let result = isSubject.get(key);
    if (!result) {
      const parsed = parseActor(actor);
      result = parsed
        ? readActorIdentity(parsed).then(
            (resolved) => resolved?.user?.id === subject.id,
          )
        : Promise.resolve(false);
      isSubject.set(key, result);
    }
    return result;
  };
  const replied = await Promise.all(
    gaps.map((gap) => repliedBySubject(gap.replyActor)),
  );
  const own = gaps.filter((_, index) => replied[index]);
  return personReplyTimesReportSchema.parse({
    days: args.days,
    depths: TURN_DEPTHS.map((depth) => ({
      depth,
      histogram: gapHistogramReport(
        own.filter((gap) => gap.depth === depth).map((gap) => gap.gapMs),
      ),
    })),
    generatedAt: new Date(nowMs).toISOString(),
    histogram: gapHistogramReport(own.map((gap) => gap.gapMs)),
    partial: canceledBatches > 0,
  });
}
