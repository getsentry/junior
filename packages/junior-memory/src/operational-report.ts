import type {
  PluginConversationEventCostDay,
  PluginOperationalReportContent,
} from "@sentry/junior-plugin-api";
import { and, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { juniorMemoryEmbeddings, juniorMemoryMemories } from "./db/schema";
import type { MemoryDb } from "./store";

const DAY_MS = 24 * 60 * 60 * 1_000;
// TODO: add hour categories + `1` when these system widgets can plot 24h hourly.
const WINDOWS = [7, 30, 90] as const;

function startOfUtcDay(value: number): Date {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function aggregateMemoryDays(args: { db: MemoryDb; nowMs: number }) {
  const end = startOfUtcDay(args.nowMs);
  const start = startOfUtcDay(args.nowMs - (WINDOWS.at(-1)! - 1) * DAY_MS);
  const table = juniorMemoryMemories;
  const date = sql<string>`to_char(to_timestamp(${table.createdAtMs} / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await args.db
    .select({
      date,
      private:
        sql<number>`count(*) filter (where ${table.scope} = 'private')`.mapWith(
          Number,
        ),
      public:
        sql<number>`count(*) filter (where ${table.scope} = 'public')`.mapWith(
          Number,
        ),
    })
    .from(table)
    .where(
      and(
        gte(table.createdAtMs, start.getTime()),
        lt(table.createdAtMs, end.getTime() + DAY_MS),
      ),
    )
    .groupBy(date);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days: { date: string; private: number; public: number }[] = [];
  for (let ms = start.getTime(); ms <= end.getTime(); ms += DAY_MS) {
    const day = new Date(ms).toISOString().slice(0, 10);
    const row = byDate.get(day);
    days.push({
      date: day,
      private: row?.private ?? 0,
      public: row?.public ?? 0,
    });
  }
  return days;
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
        // EXISTS, not a join: a memory can have one vector per model.
        embedded:
          sql<number>`count(*) filter (where ${active} and exists (select 1 from ${juniorMemoryEmbeddings} where ${juniorMemoryEmbeddings.memoryId} = ${juniorMemoryMemories.id}))`.mapWith(
            Number,
          ),
        private:
          sql<number>`count(*) filter (where ${active} and ${juniorMemoryMemories.scope} = 'private')`.mapWith(
            Number,
          ),
      })
      .from(juniorMemoryMemories),
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
        description: "Memories stored by scope",
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
