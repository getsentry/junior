import { createHash } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { getDashboardPersonLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import { createCache } from "@/chat/state/cache";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { readConversationAccessFromSql } from "../conversations/access";
import { summaryFromRow } from "../conversations/reporting";
import { resolvePersonLink } from "../objects/person";
import {
  PERSON_CARD_RECENT_LIMIT,
  type PersonCardReport,
} from "../schema/person";
import { normalizeEmail, verifiedActorWhere } from "./shared";

// The card counts Turns in the last week, and finds the last Turn and the
// recent Conversations in the last month. Both read a bounded range of the
// (actor Identity, time) index of the metric rows.
const COUNT_DAYS = 7;
const RECENT_DAYS = 30;
// Some recent Conversations can be private to the viewer, so read a few
// more than the card lists.
const RECENT_CANDIDATES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const CARD_TTL_MS = 60_000;

// One row per Turn of a verified person since `since`, with its root
// Conversation. Every Run has one `duration_ms` row.
function personCardTurns(email: string, since: Date) {
  return getDb()
    .select({
      occurredAt: juniorConversationMetrics.occurredAt,
      rootConversationId: sql<string>`coalesce(
        ${juniorConversations.rootConversationId},
        ${juniorConversations.conversationId}
      )`.as("card_root_conversation_id"),
    })
    .from(juniorConversationMetrics)
    .innerJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorConversationMetrics.conversationId,
      ),
    )
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversationMetrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        verifiedActorWhere(email),
        eq(juniorConversationMetrics.metric, "duration_ms"),
        gte(juniorConversationMetrics.occurredAt, since),
      ),
    )
    .as("person_card_turns");
}

async function readPersonActivity(
  email: string,
  viewer: User,
  nowMs: number,
): Promise<PersonCardReport["activity"]> {
  const weekStart = new Date(nowMs - COUNT_DAYS * DAY_MS);
  const turns = personCardTurns(email, new Date(nowMs - RECENT_DAYS * DAY_MS));
  const inWeek = sql`${turns.occurredAt} >= ${weekStart}`;
  const lastTurns = getDb()
    .select({
      lastTurnAt: sql<Date>`max(${turns.occurredAt})`.as("card_last_turn_at"),
      rootConversationId: turns.rootConversationId,
    })
    .from(turns)
    .groupBy(turns.rootConversationId)
    .as("person_card_roots");
  const [[totals], recentRows] = await Promise.all([
    getDb()
      .select({
        conversations: sql<number>`COUNT(DISTINCT ${turns.rootConversationId}) FILTER (WHERE ${inWeek})::integer`,
        lastActiveAt: sql`max(${turns.occurredAt})`.mapWith(
          juniorConversationMetrics.occurredAt,
        ),
        turns: sql<number>`COUNT(*) FILTER (WHERE ${inWeek})::integer`,
      })
      .from(turns),
    getDb()
      .select({
        archivedAt: juniorConversations.archivedAt,
        channelName: juniorConversations.channelName,
        conversationId: juniorConversations.conversationId,
        createdAt: juniorConversations.createdAt,
        durationMs: juniorConversations.durationMs,
        executionStatus: juniorConversations.executionStatus,
        executionUpdatedAt: juniorConversations.executionUpdatedAt,
        kind: juniorConversations.kind,
        lastActivityAt: juniorConversations.lastActivityAt,
        lastTurnAt: sql`${lastTurns.lastTurnAt}`.mapWith(
          juniorConversationMetrics.occurredAt,
        ),
        parentConversationId: juniorConversations.parentConversationId,
        source: juniorConversations.source,
        stoppedAt: juniorConversations.stoppedAt,
        title: juniorConversations.title,
        updatedAt: juniorConversations.updatedAt,
        usage: juniorConversations.usage,
      })
      .from(lastTurns)
      .innerJoin(
        juniorConversations,
        eq(juniorConversations.conversationId, lastTurns.rootConversationId),
      )
      .orderBy(
        desc(lastTurns.lastTurnAt),
        asc(juniorConversations.conversationId),
      )
      .limit(RECENT_CANDIDATES),
  ]);
  // The card names only Conversations that the viewer may read: public
  // ones, and private ones that they take part in.
  const access = await readConversationAccessFromSql(
    getDb(),
    recentRows.map((row) => row.conversationId),
    viewer,
  );
  const recentConversations = recentRows
    .flatMap(({ lastTurnAt, ...row }) => {
      const rowAccess = access.get(row.conversationId);
      if (!rowAccess?.canViewPrivateContent) return [];
      const summary = summaryFromRow(
        {
          ...row,
          destinationId: rowAccess.destinationId ?? null,
          email: null,
          fullName: null,
          handle: null,
          providerSubjectId: null,
        },
        { access: rowAccess },
      );
      return [
        {
          conversationId: row.conversationId,
          lastTurnAt: lastTurnAt.toISOString(),
          title: summary.displayTitle,
        },
      ];
    })
    .slice(0, PERSON_CARD_RECENT_LIMIT);
  return {
    conversations: totals?.conversations ?? 0,
    ...(totals?.lastActiveAt
      ? { lastActiveAt: totals.lastActiveAt.toISOString() }
      : undefined),
    recentConversations,
    turns: totals?.turns ?? 0,
  };
}

/**
 * Read the card of one person for a viewer: their object card and their
 * recent Junior activity. Each viewer and person pair is cached briefly, so
 * a reader who hovers the same person again reads nothing.
 */
export async function readPersonCard(
  email: string,
  viewer: User,
): Promise<PersonCardReport> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      activity: {
        conversations: 0,
        recentConversations: [],
        turns: 0,
      },
    };
  }
  const link = getDashboardPersonLink(normalizedEmail);
  const key = `${viewer.id}:${createHash("sha256").update(normalizedEmail).digest("hex")}`;
  return createCache(getStateAdapter(), "person-cards").getOrLoad(
    key,
    async () => {
      const [card, activity] = await Promise.all([
        link ? resolvePersonLink(new URL(link)) : undefined,
        readPersonActivity(normalizedEmail, viewer, Date.now()),
      ]);
      const value: PersonCardReport = {
        activity,
        ...(card ? { card: { ...card, plugin: "junior" } } : undefined),
      };
      return { ttlMs: CARD_TTL_MS, value };
    },
  );
}
