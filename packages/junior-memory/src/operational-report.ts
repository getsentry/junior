import type {
  PluginConversationEventCostDay,
  PluginOperationalReportContent,
} from "@sentry/junior-plugin-api";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import type { MemoryDb } from "./memories";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

const memoryDaySchema = z
  .object({
    date: z.string().date(),
    private: z.number().int().nonnegative(),
    public: z.number().int().nonnegative(),
  })
  .strict();

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("Memory activity query did not return rows");
  }
  return result.rows;
}

function startOfUtcDay(value: number): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function aggregateMemoryDays(args: { db: MemoryDb; nowMs: number }) {
  const end = startOfUtcDay(args.nowMs);
  const start = startOfUtcDay(args.nowMs - (WINDOWS.at(-1)! - 1) * DAY_MS);
  const endExclusiveMs = end.getTime() + DAY_MS;
  const table = juniorMemoryMemories;
  const result = await args.db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${start}::timestamptz AT TIME ZONE 'UTC'),
        date_trunc('day', ${end}::timestamptz AT TIME ZONE 'UTC'),
        interval '1 day'
      ) AS day
    ), daily AS (
      SELECT
        date_trunc(
          'day',
          to_timestamp(${table.createdAtMs} / 1000.0) AT TIME ZONE 'UTC'
        ) AS day,
        count(*) FILTER (
          WHERE ${table.scope} = 'private'
        )::integer AS private,
        count(*) FILTER (
          WHERE ${table.scope} = 'public'
        )::integer AS public
      FROM ${table}
      WHERE ${table.createdAtMs} >= ${start.getTime()}
        AND ${table.createdAtMs} < ${endExclusiveMs}
      GROUP BY date_trunc(
        'day',
        to_timestamp(${table.createdAtMs} / 1000.0) AT TIME ZONE 'UTC'
      )
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS date,
      coalesce(daily.private, 0)::integer AS private,
      coalesce(daily.public, 0)::integer AS public
    FROM days
    LEFT JOIN daily ON daily.day = days.day
    ORDER BY days.day
  `);
  return z.array(memoryDaySchema).parse(queryRows(result));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    style: "percent",
  }).format(value);
}

function formatUsd(value: number): string {
  const maximumFractionDigits = value > 0 && value < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

/** Build aggregate memory storage and indexing diagnostics for the System page. */
export async function buildMemoryOperationalReport(args: {
  db: MemoryDb;
  extractionDays: PluginConversationEventCostDay[];
  nowMs: number;
}): Promise<PluginOperationalReportContent> {
  const active = and(
    isNull(juniorMemoryMemories.archivedAtMs),
    isNull(juniorMemoryMemories.supersededAtMs),
    isNull(juniorMemoryMemories.supersededById),
    or(
      isNull(juniorMemoryMemories.expiresAtMs),
      gt(juniorMemoryMemories.expiresAtMs, args.nowMs),
    ),
  );
  const [[counts], memoryDays] = await Promise.all([
    args.db
      .select({
        active: sql<number>`count(*) filter (where ${active})`.mapWith(Number),
        public:
          sql<number>`count(*) filter (where ${active} and ${juniorMemoryMemories.scope} = 'public')`.mapWith(
            Number,
          ),
        createdThirtyDays:
          sql<number>`count(*) filter (where ${juniorMemoryMemories.createdAtMs} >= ${args.nowMs - 30 * DAY_MS})`.mapWith(
            Number,
          ),
        embedded:
          sql<number>`count(${juniorMemoryEmbeddings.memoryId}) filter (where ${active})`.mapWith(
            Number,
          ),
        private:
          sql<number>`count(*) filter (where ${active} and ${juniorMemoryMemories.scope} = 'private')`.mapWith(
            Number,
          ),
      })
      .from(juniorMemoryMemories)
      .leftJoin(
        juniorMemoryEmbeddings,
        eq(juniorMemoryEmbeddings.memoryId, juniorMemoryMemories.id),
      ),
    aggregateMemoryDays(args),
  ]);

  const activeCount = counts?.active ?? 0;
  const embeddedCount = counts?.embedded ?? 0;
  const embeddingCoverage = activeCount === 0 ? 0 : embeddedCount / activeCount;
  const extractionThirtyDays = args.extractionDays.slice(-30);
  const extractionCostThirtyDays = extractionThirtyDays.reduce(
    (total, day) => total + day.costUsd,
    0,
  );

  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    title: "Memory",
    metrics: [
      {
        label: "active memories",
        tone: activeCount > 0 ? "good" : "neutral",
        value: formatCount(activeCount),
      },
      {
        label: "extraction cost · 30d",
        value: formatUsd(extractionCostThirtyDays),
      },
      {
        label: "created · 30d",
        value: formatCount(counts?.createdThirtyDays ?? 0),
      },
      {
        label: "private",
        value: formatCount(counts?.private ?? 0),
      },
      {
        label: "public",
        value: formatCount(counts?.public ?? 0),
      },
      {
        label: "embedding coverage",
        tone:
          activeCount === 0
            ? "neutral"
            : embeddedCount === activeCount
              ? "good"
              : "warning",
        value: formatPercent(embeddingCoverage),
      },
    ],
    widgets: [
      {
        categories: args.extractionDays.map((day) => ({
          id: day.date,
          label: day.date,
          values: { costUsd: day.costUsd },
        })),
        description: "Estimated model cost of passive memory extraction",
        id: "extraction-cost",
        series: [{ format: "usd", key: "costUsd", label: "Cost" }],
        timeRangeDays: [...WINDOWS],
        title: "Extraction cost",
        type: "bar_chart",
      },
      {
        categories: memoryDays.map((day) => ({
          id: day.date,
          label: day.date,
          values: {
            private: day.private,
            public: day.public,
          },
        })),
        description: "Memories stored per day by scope",
        id: "memories-created",
        series: [
          { key: "private", label: "Private" },
          { key: "public", label: "Public" },
        ],
        timeRangeDays: [...WINDOWS],
        title: "Memories created",
        type: "bar_chart",
      },
    ],
  };
}
