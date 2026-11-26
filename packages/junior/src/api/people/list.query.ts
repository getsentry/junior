import { and, eq, exists, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { microUsdSql, microUsdToUsd } from "@/db/micro-usd";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type {
  ActorDirectoryReport,
  ActorIdentity,
  ActorSummaryReport,
  ActorWindowMetrics,
  PeopleActivityDayReport,
} from "../schema/person";
import { conversationRootId, verifiedActorWhere } from "./person-report";
import {
  DAY_MS,
  HOUR_MS,
  WINDOW_SEVEN_DAY_HOURS,
  fillUtcDays,
  fillUtcHours,
  fillUtcSixHours,
  trailingUtcDayWindow,
  trailingUtcHourWindow,
  trailingUtcSixHourWindow,
} from "../reporting-window";

const DIRECTORY_ACTIVITY_DAYS = 90;

type Range = 1 | 7 | 30 | 90;

const metrics = juniorConversationMetrics;

function emptyDirectoryDay(date: string): PeopleActivityDayReport {
  return { activePeople: 0, conversations: 0, date };
}

type ActivityUnit = "day" | "hour" | "six_hour";

/** Pick one series from activity rows, without the unit. */
function activitySeries(
  rows: (PeopleActivityDayReport & { unit: string })[],
  unit: ActivityUnit,
): PeopleActivityDayReport[] {
  return rows
    .filter((row) => row.unit === unit)
    .map(({ activePeople, conversations, date }) => ({
      activePeople,
      conversations,
      date,
    }));
}

function directoryActivityDays(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcDays({
    count: DIRECTORY_ACTIVITY_DAYS,
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function directoryActivityHours(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcHours({
    count: WINDOW_SEVEN_DAY_HOURS,
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

function directoryActivitySixHours(
  rows: PeopleActivityDayReport[],
  nowMs: number,
): PeopleActivityDayReport[] {
  return fillUtcSixHours({
    empty: emptyDirectoryDay,
    nowMs,
    rows: new Map(rows.map((row) => [row.date, row])),
  });
}

/** Start of the current period of each directory range. */
function rangeStart(nowMs: number, range: Range): Date {
  return range === 1
    ? trailingUtcHourWindow(nowMs, 24).start
    : trailingUtcDayWindow(nowMs, range).start;
}

/** Start of the prior period of each range, of equal length. */
function rangePriorStart(nowMs: number, range: Range): Date {
  return new Date(
    rangeStart(nowMs, range).getTime() -
      (range === 1 ? 24 * HOUR_MS : range * DAY_MS),
  );
}

type SpendMetric = "cost_micro_usd" | "duration_ms";

/**
 * Sum one metric of one range: the current period and, for cost, the prior
 * period. A column that does not apply to the metric is null, so the cost
 * and duration branches of `identitySpend` have the same columns.
 */
function rangeSpendSums(nowMs: number, range: Range, metric: SpendMetric) {
  const start = rangeStart(nowMs, range);
  const sumWhere = (when: SQL | undefined) =>
    sql<number | null>`sum(${metrics.value}) FILTER (WHERE ${when})`;
  const none = sql<number | null>`NULL::double precision`;
  const current = sumWhere(gte(metrics.occurredAt, start));
  const prior = sumWhere(
    and(
      gte(metrics.occurredAt, rangePriorStart(nowMs, range)),
      lt(metrics.occurredAt, start),
    ),
  );
  const cost = metric === "cost_micro_usd";
  return {
    costMicroUsd: (cost ? current : none).as(`cost_micro_usd_${range}`),
    durationMs: (cost ? none : current).as(`duration_ms_${range}`),
    priorCostMicroUsd: (cost ? prior : none).as(
      `prior_cost_micro_usd_${range}`,
    ),
  };
}

/**
 * Sum each identity's spend in every range in one pass over the metric
 * rows, grouped before any join. Cost and duration are separate branches,
 * so each row checks only its own metric's periods, and duration rows are
 * read only for the longest current period.
 */
function identitySpend(nowMs: number) {
  const byIdentity = (metric: SpendMetric, since: Date) =>
    getDb()
      .select({
        identityId: sql<string>`${metrics.actorIdentityId}`.as(
          "identity_totals_id",
        ),
        1: rangeSpendSums(nowMs, 1, metric),
        7: rangeSpendSums(nowMs, 7, metric),
        30: rangeSpendSums(nowMs, 30, metric),
        90: rangeSpendSums(nowMs, 90, metric),
      })
      .from(metrics)
      .where(and(eq(metrics.metric, metric), gte(metrics.occurredAt, since)))
      .groupBy(metrics.actorIdentityId);
  return byIdentity("cost_micro_usd", rangePriorStart(nowMs, 90))
    .unionAll(byIdentity("duration_ms", rangeStart(nowMs, 90)))
    .as("person_identity_totals");
}

/** Sum one range of a person's spend over their identities. */
function rangeSpendColumns(spend: ReturnType<typeof identitySpend>[Range]) {
  return {
    costMicroUsd: microUsdSql(sql`sum(${spend.costMicroUsd})`),
    durationMs: sql<number>`COALESCE(sum(${spend.durationMs}), 0)::double precision`,
    priorCostMicroUsd: microUsdSql(sql`sum(${spend.priorCostMicroUsd})`),
  };
}

type RangeSpend = {
  costMicroUsd: number | null;
  durationMs: number;
  priorCostMicroUsd: number | null;
};

function rangeWindow(
  spend: RangeSpend | undefined,
  conversations: number,
): ActorWindowMetrics {
  return {
    conversations,
    costUsd: microUsdToUsd(spend?.costMicroUsd ?? 0),
    durationMs: spend?.durationMs ?? 0,
    priorCostUsd: microUsdToUsd(spend?.priorCostMicroUsd ?? 0),
  };
}

/**
 * Count active people and root Conversations in each bucket of each series,
 * from one read of the Turns since `since`. The Turns are grouped by bucket,
 * Identity, and Conversation before any join, so the joins and the counts
 * read a few rows for each Conversation, not one for each Turn. Six-hour
 * buckets roll up hour buckets.
 *
 * Each count is a hashed `DISTINCT` of (bucket, person) or (bucket, root)
 * pairs, which costs less than sorting for `COUNT(DISTINCT)`.
 */
function activityRows(since: Date, read: "day" | "hour") {
  const utc = sql`(${metrics.occurredAt} AT TIME ZONE 'UTC')`;
  const readBucket = sql<Date>`date_trunc(${sql.raw(`'${read}'`)}, ${utc})`;
  const bucketTurns = getDb()
    .select({
      bucket: readBucket.as("turn_bucket"),
      identityId: sql<string>`${metrics.actorIdentityId}`.as(
        "turn_identity_id",
      ),
      conversationId: sql<string>`${metrics.conversationId}`.as(
        "turn_conversation_id",
      ),
    })
    .from(metrics)
    .where(
      and(
        // Every Run writes one `duration_ms` row.
        eq(metrics.metric, "duration_ms"),
        gte(metrics.occurredAt, since),
      ),
    )
    .groupBy(readBucket, metrics.actorIdentityId, metrics.conversationId)
    .as("activity_bucket_turns");
  // One row per bucket, person, and root, so the counts read few rows.
  const turns = getDb()
    .$with("activity_turns")
    .as(
      getDb()
        .select({
          bucket: sql<Date>`${bucketTurns.bucket}`.as("activity_bucket"),
          userId: sql<string>`${juniorUsers.id}`.as("activity_user_id"),
          rootConversationId: conversationRootId.as("activity_root_id"),
        })
        .from(bucketTurns)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, bucketTurns.identityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .innerJoin(
          juniorConversations,
          eq(juniorConversations.conversationId, bucketTurns.conversationId),
        )
        .where(verifiedActorWhere())
        .groupBy(bucketTurns.bucket, juniorUsers.id, conversationRootId),
    );
  const unitCounts = (unit: ActivityUnit) => {
    const bucket =
      unit === "six_hour"
        ? sql<Date>`date_trunc('day', ${turns.bucket}) + FLOOR(EXTRACT(HOUR FROM ${turns.bucket}) / 6) * INTERVAL '6 hours'`
        : sql<Date>`${turns.bucket}`;
    const pairs = (kind: "people" | "conversations", id: SQL) =>
      getDb()
        .selectDistinct({
          bucket: bucket.as("pair_bucket"),
          kind: sql<string>`${kind}::text`.as("pair_kind"),
          id: sql<string>`${id}`.as("pair_id"),
        })
        .from(turns);
    const allPairs = pairs("people", sql`${turns.userId}`)
      .unionAll(pairs("conversations", sql`${turns.rootConversationId}`))
      .as("activity_pairs");
    const format = unit === "day" ? "YYYY-MM-DD" : 'YYYY-MM-DD"T"HH24';
    return getDb()
      .select({
        unit: sql<ActivityUnit>`${unit}::text`.as("activity_unit"),
        activePeople:
          sql<number>`(count(*) FILTER (WHERE ${allPairs.kind} = 'people'))::int`.as(
            "activity_people",
          ),
        conversations:
          sql<number>`(count(*) FILTER (WHERE ${allPairs.kind} = 'conversations'))::int`.as(
            "activity_conversations",
          ),
        date: sql<string>`TO_CHAR(${allPairs.bucket}, ${sql.raw(`'${format}'`)})`.as(
          "activity_date",
        ),
      })
      .from(allPairs)
      .groupBy(allPairs.bucket);
  };
  const counts =
    read === "day"
      ? unitCounts("day").as("activity_counts")
      : unitCounts("hour")
          .unionAll(unitCounts("six_hour"))
          .as("activity_counts");
  return getDb().with(turns).select().from(counts);
}

/**
 * Read one row per verified person who ever ran a Turn: their identity and
 * their first and last Turn over all time. Each edge is a probe of the actor
 * index, so the cost grows with identities, not with Turns.
 */
function personTurnRange() {
  const edge = (fn: "min" | "max") =>
    sql`(${getDb()
      .select({ at: sql`${sql.raw(fn)}(${metrics.occurredAt})` })
      .from(metrics)
      .where(eq(metrics.actorIdentityId, juniorIdentities.id))})`;
  return getDb()
    .select({
      userId: sql<string>`${juniorUsers.id}`.as("range_user_id"),
      email: sql<string>`${juniorUsers.primaryEmailNormalized}`.as(
        "range_email",
      ),
      fullName: sql<string | null>`${juniorUsers.displayName}`.as(
        "range_full_name",
      ),
      firstAt: sql<Date>`min(${edge("min")})`.as("range_first_at"),
      lastAt: sql<Date>`max(${edge("max")})`.as("range_last_at"),
      // Web identities use the email as the subject. Only Slack fills these.
      slackUserId: sql<
        string | null
      >`max(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.providerSubjectId} END)`.as(
        "range_slack_user_id",
      ),
      slackUserName: sql<
        string | null
      >`max(CASE WHEN ${juniorIdentities.provider} = 'slack' THEN ${juniorIdentities.handle} END)`.as(
        "range_slack_user_name",
      ),
    })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        verifiedActorWhere(),
        exists(
          getDb()
            .select({ one: sql`1` })
            .from(metrics)
            .where(eq(metrics.actorIdentityId, juniorIdentities.id)),
        ),
      ),
    )
    .groupBy(juniorUsers.id)
    .as("person_turn_range");
}

/**
 * Count each person's root Conversations with a Turn in each range. Only
 * Turns since the start of the longest range are read, and they are grouped
 * before any join.
 */
function personRangeConversations(nowMs: number, since: Date) {
  const verifiedIdentities = getDb()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(verifiedActorWhere());
  const turns = getDb()
    .select({
      identityId: sql<string>`${metrics.actorIdentityId}`.as(
        "recent_identity_id",
      ),
      conversationId: sql<string>`${metrics.conversationId}`.as(
        "recent_conversation_id",
      ),
      lastAt: sql<Date>`max(${metrics.occurredAt})`.as("recent_last_at"),
    })
    .from(metrics)
    .where(
      and(
        inArray(metrics.actorIdentityId, verifiedIdentities),
        // Every Run writes one `duration_ms` row.
        eq(metrics.metric, "duration_ms"),
        gte(metrics.occurredAt, since),
      ),
    )
    .groupBy(metrics.actorIdentityId, metrics.conversationId)
    .as("person_recent_turns");
  const roots = getDb()
    .select({
      userId: sql<string>`${juniorIdentities.userId}`.as("recent_user_id"),
      lastAt: sql<Date>`max(${turns.lastAt})`.as("recent_root_last_at"),
    })
    .from(turns)
    .innerJoin(juniorIdentities, eq(juniorIdentities.id, turns.identityId))
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, turns.conversationId),
    )
    .groupBy(juniorIdentities.userId, conversationRootId)
    .as("person_recent_roots");
  const count = (range: Range) =>
    sql<number>`(count(*) FILTER (
      WHERE ${roots.lastAt} >= ${rangeStart(nowMs, range).toISOString()}::timestamptz
    ))::integer`;
  return getDb()
    .select({
      userId: sql<string>`${roots.userId}`.as("range_count_user_id"),
      conversations1: count(1).as("range_conversations_1"),
      conversations7: count(7).as("range_conversations_7"),
      conversations30: count(30).as("range_conversations_30"),
      conversations90: count(90).as("range_conversations_90"),
    })
    .from(roots)
    .groupBy(roots.userId)
    .as("person_range_conversations");
}

/**
 * Load the complete People directory with grouping and metrics owned by SQL.
 *
 * Every count and total comes from Turns. A person counts a Conversation when
 * they ran a Turn in it, whoever started it. Only the Turn range is
 * all-time; every other statement reads at most the last 180 days.
 */
export async function readPeopleListFromSql(): Promise<ActorDirectoryReport> {
  const nowMs = Date.now();
  const { end, start } = trailingUtcDayWindow(nowMs, DIRECTORY_ACTIVITY_DAYS);
  const hourWindow = trailingUtcHourWindow(nowMs, WINDOW_SEVEN_DAY_HOURS);
  const sixHourWindow = trailingUtcSixHourWindow(nowMs);
  // One hour read serves the hour and six-hour series.
  const hourlySince = new Date(
    Math.min(hourWindow.start.getTime(), sixHourWindow.start.getTime()),
  );
  const range = personTurnRange();
  const counts = personRangeConversations(nowMs, start);
  const spendByIdentity = identitySpend(nowMs);
  const rangeCount = (column: SQL.Aliased<number>) =>
    sql<number>`COALESCE(${column}, 0)::integer`;
  const [rows, activityDayRows, activityHourAndSixHourRows, spend] =
    await Promise.all([
      getDb()
        .select({
          email: range.email,
          fullName: range.fullName,
          firstSeenAt: sql`${range.firstAt}`.mapWith(metrics.occurredAt),
          lastSeenAt: sql`${range.lastAt}`.mapWith(metrics.occurredAt),
          slackUserId: range.slackUserId,
          slackUserName: range.slackUserName,
          conversations1: rangeCount(counts.conversations1),
          conversations7: rangeCount(counts.conversations7),
          conversations30: rangeCount(counts.conversations30),
          conversations90: rangeCount(counts.conversations90),
        })
        .from(range)
        .leftJoin(counts, eq(counts.userId, range.userId)),
      activityRows(start, "day"),
      activityRows(hourlySince, "hour"),
      getDb()
        .select({
          email: sql<string>`${juniorUsers.primaryEmailNormalized}`,
          1: rangeSpendColumns(spendByIdentity[1]),
          7: rangeSpendColumns(spendByIdentity[7]),
          30: rangeSpendColumns(spendByIdentity[30]),
          90: rangeSpendColumns(spendByIdentity[90]),
        })
        .from(spendByIdentity)
        .innerJoin(
          juniorIdentities,
          eq(juniorIdentities.id, spendByIdentity.identityId),
        )
        .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
        .where(verifiedActorWhere())
        .groupBy(juniorUsers.id),
    ]);

  const spendByEmail = new Map(spend.map((row) => [row.email, row]));
  const people: ActorSummaryReport[] = rows.map((row) => {
    const actor: ActorIdentity & { email: string } = {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : undefined),
      ...(row.slackUserId ? { slackUserId: row.slackUserId } : undefined),
      ...(row.slackUserName ? { slackUserName: row.slackUserName } : undefined),
    };
    const personSpend = spendByEmail.get(row.email);
    return {
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      actor,
      windows: {
        1: rangeWindow(personSpend?.[1], row.conversations1),
        7: rangeWindow(personSpend?.[7], row.conversations7),
        30: rangeWindow(personSpend?.[30], row.conversations30),
        90: rangeWindow(personSpend?.[90], row.conversations90),
      },
    };
  });

  return {
    activityDays: directoryActivityDays(
      activitySeries(activityDayRows, "day"),
      nowMs,
    ),
    activityHours: directoryActivityHours(
      activitySeries(activityHourAndSixHourRows, "hour"),
      nowMs,
    ),
    activitySixHours: directoryActivitySixHours(
      activitySeries(activityHourAndSixHourRows, "six_hour"),
      nowMs,
    ),
    generatedAt: new Date(nowMs).toISOString(),
    people: people.sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.windows[90].conversations - left.windows[90].conversations ||
        left.actor.email.localeCompare(right.actor.email),
    ),
    source: "conversation_index",
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
