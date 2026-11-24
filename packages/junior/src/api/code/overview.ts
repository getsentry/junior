import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import * as z from "zod";
import type {
  CodeChangeSize,
  CodeChangeState,
  User,
} from "@sentry/junior-plugin-api";
import { codeChangeUrl, codeRepositoryUrl } from "@/chat/code/links";
import { getDb } from "@/chat/db";
import {
  juniorCodeChanges,
  juniorCodeRepositories,
  juniorConversations,
  juniorUsers,
} from "@/db/schema";
import { conversationUsageCostExpr } from "../conversations/aggregate";
import { decodePageCursor, encodePageCursor } from "../page-cursor";
import {
  IDLE_CHANGE_DAYS,
  type CodeOverviewReport,
  type CodePersonReport,
} from "../schema/code";
import { sumUtcHoursIntoSixHours } from "../reporting-window";
import { readCodeChangeStacks } from "./stacks";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_DAYS = 30;
const ACTIVITY_DAYS = 90;
/**
 * Code changes on one page of a person's code overview. Open changes sort
 * first, so the first page has the open changes before completed ones, and
 * `nextCursor` reads the rest.
 */
const PERSON_CHANGE_LIMIT = 100;

type ChangeTimes = {
  closedAt: Date | null;
  mergedAt: Date | null;
  openedAt: Date;
  state: CodeChangeState;
};

type ActivityBucket = {
  closed: number;
  created: number;
  date: string;
  merged: number;
};

function startOfUtcDay(timestampMs: number): Date {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function mergeRate(merged: number, closed: number): number | undefined {
  const completed = merged + closed;
  return completed > 0 ? merged / completed : undefined;
}

// Matches Postgres percentile_cont(0.5).
function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  return (sorted[Math.floor(middle)]! + sorted[Math.ceil(middle)]!) / 2;
}

/**
 * Count created, merged, and closed changes per UTC bucket, from `start`
 * through `end`. Every bucket is present, so charts get zero gaps.
 */
function bucketActivity(
  changes: readonly ChangeTimes[],
  range: { end: Date; keyLength: number; start: Date; stepMs: number },
): ActivityBucket[] {
  const buckets = new Map<string, ActivityBucket>();
  for (
    let ms = range.start.getTime();
    ms <= range.end.getTime();
    ms += range.stepMs
  ) {
    const date = new Date(ms).toISOString().slice(0, range.keyLength);
    buckets.set(date, { closed: 0, created: 0, date, merged: 0 });
  }
  const add = (at: Date | null, kind: "closed" | "created" | "merged") => {
    if (!at || at < range.start) return;
    const bucket = buckets.get(at.toISOString().slice(0, range.keyLength));
    if (bucket) bucket[kind] += 1;
  };
  for (const change of changes) {
    add(change.openedAt, "created");
    add(change.mergedAt, "merged");
    if (change.state === "closed") add(change.closedAt, "closed");
  }
  return [...buckets.values()];
}

/**
 * Read conversation-tree costs for the given linked conversation ids. The
 * returned function sums each tree once, child Conversations included, so a
 * change linked to two Conversations of one tree pays for that tree once.
 */
async function readTreeCosts(conversationIds: readonly string[]) {
  const db = getDb();
  const conversations = juniorConversations;
  const ids = [...new Set(conversationIds)];
  const links = ids.length
    ? await db
        .select({
          conversationId: conversations.conversationId,
          rootId: sql<string>`coalesce(${conversations.rootConversationId}, ${conversations.conversationId})`,
        })
        .from(conversations)
        .where(inArray(conversations.conversationId, ids))
    : [];
  const rootOf = new Map(
    links.map((link) => [link.conversationId, link.rootId]),
  );
  const rootIds = [...new Set(rootOf.values())];
  const trees = rootIds.length
    ? await db
        .select({
          costUsd:
            sql<number>`coalesce(sum(${conversationUsageCostExpr(conversations.usage)}), 0)`.mapWith(
              Number,
            ),
          rootId: conversations.rootConversationId,
        })
        .from(conversations)
        .where(inArray(conversations.rootConversationId, rootIds))
        .groupBy(conversations.rootConversationId)
    : [];
  const costOf = new Map(trees.map((tree) => [tree.rootId, tree.costUsd]));
  return (linked: readonly string[]) => {
    let total = 0;
    const roots = new Set(linked.flatMap((id) => rootOf.get(id) ?? []));
    for (const root of roots) total += costOf.get(root) ?? 0;
    return total;
  };
}

/**
 * True when any linked conversation actor belongs to the subject user. The
 * subquery starts from the user's Conversations, so Postgres hash-joins them
 * with the linked ids instead of one lookup per code change.
 */
function ownedByUserSql(userId: string | SQL): SQL {
  return sql`${juniorCodeChanges.id} IN (
    SELECT linked.id
    FROM junior_identities AS identities
    INNER JOIN junior_conversations AS conversations
      ON conversations.actor_identity_id = identities.id
    INNER JOIN (
      SELECT id, unnest(conversation_ids) AS conversation_id
      FROM junior_code_changes
    ) AS linked
      ON linked.conversation_id = conversations.conversation_id
    WHERE identities.user_id = ${userId}
  )`;
}

/** Limit code changes to one person's conversations or one repository. */
function changeScopeFilter(args: {
  repositoryId?: string;
  userId?: string;
}): SQL | undefined {
  return and(
    args.userId ? ownedByUserSql(args.userId) : undefined,
    args.repositoryId
      ? eq(juniorCodeChanges.repositoryId, args.repositoryId)
      : undefined,
  );
}

/** Read windowed code summary and activity buckets for an optional scope. */
export async function readCodeWindows(args: {
  nowMs: number;
  repositoryId?: string;
  userId?: string;
}) {
  const db = getDb();
  const windowEnd = new Date(args.nowMs);
  const windowStart = new Date(args.nowMs - WINDOW_DAYS * DAY_MS);
  const activityStart = startOfUtcDay(
    args.nowMs - (ACTIVITY_DAYS - 1) * DAY_MS,
  );
  const changes = juniorCodeChanges;
  const activityHourEnd = new Date(args.nowMs);
  activityHourEnd.setUTCMinutes(0, 0, 0);
  const activityHourStart = new Date(
    activityHourEnd.getTime() - (7 * 24 - 1) * (DAY_MS / 24),
  );
  // Open changes count at any age. Other changes count only by their
  // timestamps, and the 90-day activity window covers the 30-day summary.
  const rows = await db
    .select({
      closedAt: changes.closedAt,
      conversationIds: changes.conversationIds,
      lastActivityAt: changes.lastActivityAt,
      mergedAt: changes.mergedAt,
      openedAt: changes.openedAt,
      state: changes.state,
    })
    .from(changes)
    .where(
      and(
        changeScopeFilter(args),
        or(
          gte(changes.openedAt, activityStart),
          gte(changes.mergedAt, activityStart),
          gte(changes.closedAt, activityStart),
          eq(changes.state, "open"),
        ),
      ),
    );
  const inWindow = (at: Date | null) => at !== null && at >= windowStart;
  const created = rows.filter((row) => inWindow(row.openedAt));
  const merged = rows.filter((row) => inWindow(row.mergedAt));
  const closed = rows.filter(
    (row) => row.state === "closed" && inWindow(row.closedAt),
  );
  const createdConversationIds = created.flatMap((row) => row.conversationIds);
  const treeCost = await readTreeCosts(createdConversationIds);
  const changeCosts = created.map((row) => treeCost(row.conversationIds));
  const activityHours = bucketActivity(rows, {
    end: activityHourEnd,
    keyLength: 13,
    start: activityHourStart,
    stepMs: DAY_MS / 24,
  });
  const summary = {
    closed: closed.length,
    costUsd: treeCost(createdConversationIds),
    created: created.length,
    // Same rule as the dashboard's idle marker: whole days since the last
    // activity, or since opening when no activity is recorded.
    idle: rows.filter(
      (row) =>
        row.state === "open" &&
        Math.floor(
          (args.nowMs - (row.lastActivityAt ?? row.openedAt).getTime()) /
            DAY_MS,
        ) > IDLE_CHANGE_DAYS,
    ).length,
    medianCostUsd: median(changeCosts.filter((cost) => cost > 0)),
    medianMergeTimeMs: median(
      merged.flatMap((row) =>
        row.state === "merged" && row.mergedAt
          ? [row.mergedAt.getTime() - row.openedAt.getTime()]
          : [],
      ),
    ),
    merged: merged.length,
    open: rows.filter((row) => row.state === "open").length,
  };
  return {
    activityDays: bucketActivity(rows, {
      end: startOfUtcDay(args.nowMs),
      keyLength: 10,
      start: activityStart,
      stepMs: DAY_MS,
    }),
    activityHours,
    activitySixHours: sumUtcHoursIntoSixHours({
      empty: (date) => ({ closed: 0, created: 0, date, merged: 0 }),
      hours: activityHours,
      nowMs: args.nowMs,
    }),
    summary: {
      ...summary,
      mergeRate: mergeRate(summary.merged, summary.closed),
    },
    windowEnd,
    windowStart,
  };
}

/** Columns read for one code change report row. */
export const codeChangeReportColumns = {
  additions: juniorCodeChanges.additions,
  changedFiles: juniorCodeChanges.changedFiles,
  closedAt: juniorCodeChanges.closedAt,
  deletions: juniorCodeChanges.deletions,
  draft: juniorCodeChanges.draft,
  id: juniorCodeChanges.id,
  lastActivityAt: juniorCodeChanges.lastActivityAt,
  mergedAt: juniorCodeChanges.mergedAt,
  number: juniorCodeChanges.number,
  openedAt: juniorCodeChanges.openedAt,
  provider: juniorCodeChanges.provider,
  repository: juniorCodeRepositories.name,
  state: juniorCodeChanges.state,
  title: juniorCodeChanges.title,
};

/** Convert one code change row to its report shape. */
export function codeChangeReport({
  additions,
  changedFiles,
  deletions,
  ...change
}: {
  additions: number | null;
  changedFiles: number | null;
  closedAt: Date | null;
  deletions: number | null;
  draft: boolean;
  id: string;
  lastActivityAt: Date | null;
  mergedAt: Date | null;
  number: number;
  openedAt: Date;
  provider: string;
  repository: string;
  state: CodeChangeState;
  title: string | null;
}) {
  // Each part is set only when known, so an unknown count never reads as 0.
  const size: CodeChangeSize = {};
  if (additions !== null) size.additions = additions;
  if (deletions !== null) size.deletions = deletions;
  if (changedFiles !== null) size.changedFiles = changedFiles;
  return {
    ...change,
    ...(Object.keys(size).length > 0 ? { size } : undefined),
    closedAt: change.closedAt?.toISOString(),
    lastActivityAt: change.lastActivityAt?.toISOString(),
    mergedAt: change.mergedAt?.toISOString(),
    openedAt: change.openedAt.toISOString(),
    title: change.title ?? undefined,
    url: codeChangeUrl(change),
  };
}

/** Read code activity created by Junior across installed code plugins. */
export async function readCodeOverview(
  nowMs = Date.now(),
): Promise<CodeOverviewReport> {
  const db = getDb();
  const changes = juniorCodeChanges;
  const repositories = juniorCodeRepositories;
  const windows = await readCodeWindows({ nowMs });
  const windowStart = windows.windowStart;
  const created =
    sql<number>`count(*) filter (where ${changes.openedAt} >= ${windowStart})`.mapWith(
      Number,
    );
  const merged =
    sql<number>`count(*) filter (where ${changes.mergedAt} >= ${windowStart})`.mapWith(
      Number,
    );
  const recent = or(
    gte(changes.openedAt, windowStart),
    gte(changes.mergedAt, windowStart),
    gte(changes.closedAt, windowStart),
    eq(changes.state, "open"),
  );
  const [repositoryRows, recentChanges] = await Promise.all([
    db
      .select({
        closed:
          sql<number>`count(*) filter (where ${changes.state} = 'closed' and ${changes.closedAt} >= ${windowStart})`.mapWith(
            Number,
          ),
        created,
        id: repositories.id,
        merged,
        name: repositories.name,
        open: sql<number>`count(*) filter (where ${changes.state} = 'open')`.mapWith(
          Number,
        ),
        provider: repositories.provider,
      })
      .from(repositories)
      .innerJoin(changes, eq(changes.repositoryId, repositories.id))
      .where(recent)
      .groupBy(repositories.id)
      .orderBy(desc(merged), desc(created), asc(repositories.name))
      .limit(25),
    db
      .select(codeChangeReportColumns)
      .from(changes)
      .innerJoin(repositories, eq(changes.repositoryId, repositories.id))
      .where(recent)
      .orderBy(desc(changes.updatedAt))
      .limit(25),
  ]);
  const repositoryChanges = repositoryRows.length
    ? await db
        .select({
          conversationIds: changes.conversationIds,
          repositoryId: changes.repositoryId,
        })
        .from(changes)
        .where(
          and(
            gte(changes.openedAt, windowStart),
            inArray(
              changes.repositoryId,
              repositoryRows.map((row) => row.id),
            ),
          ),
        )
    : [];
  const treeCost = await readTreeCosts(
    repositoryChanges.flatMap((change) => change.conversationIds),
  );
  const repositoryCosts = new Map<string, number[]>();
  for (const change of repositoryChanges) {
    const cost = treeCost(change.conversationIds);
    if (cost <= 0) continue;
    const costs = repositoryCosts.get(change.repositoryId) ?? [];
    costs.push(cost);
    repositoryCosts.set(change.repositoryId, costs);
  }
  return {
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    changes: recentChanges.map(codeChangeReport),
    generatedAt: windows.windowEnd.toISOString(),
    repositories: repositoryRows.map((repository) => ({
      ...repository,
      medianCostUsd: median(repositoryCosts.get(repository.id) ?? []),
      mergeRate: mergeRate(repository.merged, repository.closed),
      url: codeRepositoryUrl(repository),
    })),
    summary: windows.summary,
    windowEnd: windows.windowEnd.toISOString(),
    windowStart: windows.windowStart.toISOString(),
  };
}

/**
 * Position after the last change of a page of a person's code overview.
 * `idleSince` is set only when that change was open. Code change times are
 * written from JavaScript dates, so milliseconds keep the order exact.
 */
const personCodeCursorSchema = z
  .object({
    // Any value Postgres reads as a uuid, so a bad id answers 400.
    id: z.guid(),
    idleSince: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const idleSince = sql`coalesce(${juniorCodeChanges.lastActivityAt}, ${juniorCodeChanges.openedAt})`;

// The changes after a cursor, in the order of `readPersonCodeOverview`.
function afterPersonCodeCursor(
  cursor: z.output<typeof personCodeCursorSchema>,
): SQL {
  const updatedAt = new Date(cursor.updatedAt);
  const laterInGroup = or(
    lt(juniorCodeChanges.updatedAt, updatedAt),
    and(
      eq(juniorCodeChanges.updatedAt, updatedAt),
      gt(juniorCodeChanges.id, cursor.id),
    ),
  )!;
  const completed = ne(juniorCodeChanges.state, "open");
  if (cursor.idleSince === undefined) return and(completed, laterInGroup)!;
  const since = sql`${cursor.idleSince}::timestamptz`;
  return or(
    completed,
    sql`${idleSince} > ${since}`,
    and(sql`${idleSince} = ${since}`, laterInGroup),
  )!;
}

/**
 * Read person-scoped code activity and recent code changes linked through
 * conversation actors on Junior-owned code changes.
 */
export async function readPersonCodeOverview(args: {
  /** `nextCursor` of the previous page. */
  cursor?: string | undefined;
  nowMs?: number;
  userId: string;
  /** The reader. A change's stack shows only when they may read its source. */
  viewer?: User | undefined;
}): Promise<CodePersonReport> {
  const nowMs = args.nowMs ?? Date.now();
  const after = args.cursor
    ? decodePageCursor(
        personCodeCursorSchema,
        args.cursor,
        "Invalid code change cursor.",
      )
    : undefined;
  const db = getDb();
  const [windows, changes] = await Promise.all([
    readCodeWindows({ nowMs, userId: args.userId }),
    db
      .select({
        change: codeChangeReportColumns,
        conversationIds: juniorCodeChanges.conversationIds,
        updatedAt: juniorCodeChanges.updatedAt,
      })
      .from(juniorCodeChanges)
      .innerJoin(
        juniorCodeRepositories,
        eq(juniorCodeChanges.repositoryId, juniorCodeRepositories.id),
      )
      .where(
        and(
          changeScopeFilter({ userId: args.userId }),
          after ? afterPersonCodeCursor(after) : undefined,
        ),
      )
      // Open changes first, longest idle first, then the latest completed
      // changes. The id keeps the order stable from one page to the next.
      .orderBy(
        desc(sql`${juniorCodeChanges.state} = 'open'`),
        asc(
          sql`CASE WHEN ${juniorCodeChanges.state} = 'open' THEN ${idleSince} END`,
        ),
        desc(juniorCodeChanges.updatedAt),
        asc(juniorCodeChanges.id),
      )
      .limit(PERSON_CHANGE_LIMIT),
  ]);
  const stacks = await readCodeChangeStacks(
    db,
    changes.map((row) => ({
      conversationIds: row.conversationIds,
      id: row.change.id,
    })),
    args.viewer,
  );
  const last = changes.at(-1);
  return {
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    changes: changes.map((row) => {
      const stack = stacks.get(row.change.id);
      return {
        ...codeChangeReport(row.change),
        ...(stack ? { stack } : undefined),
      };
    }),
    generatedAt: windows.windowEnd.toISOString(),
    nextCursor:
      last && changes.length === PERSON_CHANGE_LIMIT
        ? encodePageCursor(personCodeCursorSchema, {
            id: last.change.id,
            ...(last.change.state === "open"
              ? {
                  idleSince: (
                    last.change.lastActivityAt ?? last.change.openedAt
                  ).toISOString(),
                }
              : undefined),
            updatedAt: last.updatedAt.toISOString(),
          })
        : undefined,
    summary: windows.summary,
    windowEnd: windows.windowEnd.toISOString(),
    windowStart: windows.windowStart.toISOString(),
  };
}

/**
 * Read the code changes that one person merged most recently, by their
 * normalized email, in one statement.
 */
export async function readPersonMergedChanges(args: {
  email: string;
  limit: number;
}) {
  const userId = getDb()
    .select({ id: juniorUsers.id })
    .from(juniorUsers)
    .where(eq(juniorUsers.primaryEmailNormalized, args.email));
  const rows = await getDb()
    .select({ change: codeChangeReportColumns })
    .from(juniorCodeChanges)
    .innerJoin(
      juniorCodeRepositories,
      eq(juniorCodeChanges.repositoryId, juniorCodeRepositories.id),
    )
    .where(
      and(
        ownedByUserSql(sql`(${userId})`),
        eq(juniorCodeChanges.state, "merged"),
        isNotNull(juniorCodeChanges.mergedAt),
      ),
    )
    .orderBy(desc(juniorCodeChanges.mergedAt), asc(juniorCodeChanges.id))
    .limit(args.limit);
  return rows.map((row) => codeChangeReport(row.change));
}
