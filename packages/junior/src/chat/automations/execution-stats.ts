import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lte,
  max,
  or,
  sql,
} from "drizzle-orm";
import { conversationUsageCostExpr } from "@/api/conversations/aggregate";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { agentTurnCostUsd, agentTurnTotalTokens } from "@/chat/usage";
import { juniorConversations } from "@/db/schema/conversations";
import {
  juniorAutomationExecutions,
  type AutomationExecutionStatus,
} from "@/db/schema/automation-executions";

export const AUTOMATION_EXECUTION_TYPES = ["scheduled", "event"] as const;
export const AUTOMATION_EXECUTION_STATUSES = [
  "blocked",
  "completed",
  "failed",
] as const satisfies readonly AutomationExecutionStatus[];

export type AutomationExecutionType =
  (typeof AUTOMATION_EXECUTION_TYPES)[number];

export type AutomationExecutionDay = {
  costUsd: number;
  date: string;
  event: number;
  scheduled: number;
};

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

export type AutomationRunWindows = {
  1: number;
  7: number;
  30: number;
  90: number;
};

export type AutomationExecutionSummary = {
  lastConversationId?: string;
  lastExecutedAtMs?: number;
  runs: AutomationRunWindows;
  totalRuns: number;
};

const EMPTY_RUN_WINDOWS: AutomationRunWindows = { 1: 0, 7: 0, 30: 0, 90: 0 };

/** Empty run windows for automations with no execution history. */
export function emptyAutomationRunWindows(): AutomationRunWindows {
  return { ...EMPTY_RUN_WINDOWS };
}

export type AutomationExecutionRecord = {
  conversationId?: string;
  costUsd?: number;
  durationMs?: number;
  executedAt: string;
  executionId: string;
  status: AutomationExecutionStatus;
  title?: string;
  totalTokens?: number;
};

export type AutomationRunRecord = AutomationExecutionRecord & {
  kind: AutomationExecutionType;
  automationId: string;
};

export type AutomationExecutionStatusDay = {
  blocked: number;
  completed: number;
  date: string;
  failed: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyDay(date: string): AutomationExecutionDay {
  return { costUsd: 0, date, event: 0, scheduled: 0 };
}

function emptyStatusDay(date: string): AutomationExecutionStatusDay {
  return { blocked: 0, completed: 0, date, failed: 0 };
}

/** Record one terminal automation execution and its durable conversation when present. */
export async function recordAutomationExecution(
  type: AutomationExecutionType,
  automationId: string,
  options: {
    conversationId?: string;
    executionId: string;
    namespace?: string;
    nowMs?: number;
    status?: AutomationExecutionStatus;
  },
): Promise<void> {
  const namespace = options.namespace ?? "junior";
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "completed";
  try {
    await getDb()
      .insert(juniorAutomationExecutions)
      .values({
        ...(options.conversationId
          ? { conversationId: options.conversationId }
          : undefined),
        executedAtMs: nowMs,
        executionId: options.executionId,
        kind: type,
        namespace,
        status,
        automationId,
      })
      .onConflictDoNothing({
        target: [
          juniorAutomationExecutions.kind,
          juniorAutomationExecutions.namespace,
          juniorAutomationExecutions.executionId,
        ],
      });
  } catch (error) {
    logWarn("task.execution.stat_failed", {
      error,
      "app.task.execution.id": options.executionId,
      "app.task.execution.namespace": namespace,
      "app.task.execution.status": status,
      "app.task.execution.task_id": automationId,
      "app.task.execution.type": type,
    });
  }
}

/** Load usage analytics for all automations of one type and namespace. */
export async function readAutomationExecutionSummaries(
  type: AutomationExecutionType,
  namespace: string,
  options: { nowMs?: number } = {},
): Promise<Map<string, AutomationExecutionSummary>> {
  const nowMs = options.nowMs ?? Date.now();
  const oneDayAgoMs = nowMs - 1 * 24 * 60 * 60 * 1000;
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysAgoMs = nowMs - 90 * 24 * 60 * 60 * 1000;
  const db = getDb();
  const latest = db
    .selectDistinctOn([juniorAutomationExecutions.automationId], {
      conversationId: juniorAutomationExecutions.conversationId,
      automationId: juniorAutomationExecutions.automationId,
    })
    .from(juniorAutomationExecutions)
    .where(
      and(
        eq(juniorAutomationExecutions.kind, type),
        eq(juniorAutomationExecutions.namespace, namespace),
      ),
    )
    .orderBy(
      juniorAutomationExecutions.automationId,
      desc(juniorAutomationExecutions.executedAtMs),
      desc(juniorAutomationExecutions.executionId),
    )
    .as("latest_task_execution");
  const rows = await db
    .select({
      lastConversationId: latest.conversationId,
      lastExecutedAtMs: max(juniorAutomationExecutions.executedAtMs),
      runsLast1Day: sql<number>`count(*) filter (where ${juniorAutomationExecutions.executedAtMs} >= ${oneDayAgoMs})::int`,
      runsLast7Days: sql<number>`count(*) filter (where ${juniorAutomationExecutions.executedAtMs} >= ${sevenDaysAgoMs})::int`,
      runsLast30Days: sql<number>`count(*) filter (where ${juniorAutomationExecutions.executedAtMs} >= ${thirtyDaysAgoMs})::int`,
      runsLast90Days: sql<number>`count(*) filter (where ${juniorAutomationExecutions.executedAtMs} >= ${ninetyDaysAgoMs})::int`,
      automationId: juniorAutomationExecutions.automationId,
      totalRuns: sql<number>`count(*)::int`,
    })
    .from(juniorAutomationExecutions)
    .innerJoin(
      latest,
      eq(latest.automationId, juniorAutomationExecutions.automationId),
    )
    .where(
      and(
        eq(juniorAutomationExecutions.kind, type),
        eq(juniorAutomationExecutions.namespace, namespace),
      ),
    )
    .groupBy(juniorAutomationExecutions.automationId, latest.conversationId);
  return new Map(
    rows.map((row) => [
      row.automationId,
      {
        ...(row.lastConversationId
          ? { lastConversationId: row.lastConversationId }
          : undefined),
        ...(row.lastExecutedAtMs !== null
          ? { lastExecutedAtMs: row.lastExecutedAtMs }
          : undefined),
        runs: {
          1: row.runsLast1Day,
          7: row.runsLast7Days,
          30: row.runsLast30Days,
          90: row.runsLast90Days,
        },
        totalRuns: row.totalRuns,
      },
    ]),
  );
}

/** Load a fixed trailing window of completed executions stacked by task type. */
export async function readAutomationExecutionDays(
  dayCount = 90,
  options: { nowMs?: number } = {},
): Promise<AutomationExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorAutomationExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  const rows = await getDb()
    .select({
      count: count(),
      costUsd: sql<number | null>`SUM(${conversationCost})::double precision`,
      date: executionDate,
      kind: juniorAutomationExecutions.kind,
    })
    .from(juniorAutomationExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationExecutions.conversationId,
      ),
    )
    .where(
      and(
        gte(juniorAutomationExecutions.executedAtMs, startMs),
        lte(juniorAutomationExecutions.executedAtMs, endMs),
        eq(juniorAutomationExecutions.status, "completed"),
      ),
    )
    .groupBy(executionDate, juniorAutomationExecutions.kind)
    .orderBy(asc(executionDate), asc(juniorAutomationExecutions.kind));

  const byDate = new Map<string, AutomationExecutionDay>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = utcDate(startMs + offset * 86_400_000);
    byDate.set(date, emptyDay(date));
  }
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) continue;
    if (row.kind === "scheduled") day.scheduled = row.count;
    else if (row.kind === "event") day.event = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      day.costUsd = addUsd(day.costUsd, row.costUsd);
    }
  }
  return [...byDate.values()];
}

/** Load a fixed trailing window of completed executions stacked by hour. */
export async function readAutomationExecutionHours(
  hourCount = 7 * 24,
  options: { nowMs?: number } = {},
): Promise<AutomationExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorAutomationExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  const rows = await getDb()
    .select({
      count: count(),
      costUsd: sql<number | null>`SUM(${conversationCost})::double precision`,
      date: executionHour,
      kind: juniorAutomationExecutions.kind,
    })
    .from(juniorAutomationExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationExecutions.conversationId,
      ),
    )
    .where(
      and(
        gte(juniorAutomationExecutions.executedAtMs, startMs),
        lte(juniorAutomationExecutions.executedAtMs, endMs),
        eq(juniorAutomationExecutions.status, "completed"),
      ),
    )
    .groupBy(executionHour, juniorAutomationExecutions.kind)
    .orderBy(asc(executionHour), asc(juniorAutomationExecutions.kind));

  const byHour = new Map<string, AutomationExecutionDay>();
  for (let offset = 0; offset < hourCount; offset += 1) {
    const date = new Date(startMs + offset * 3_600_000)
      .toISOString()
      .slice(0, 13);
    byHour.set(date, emptyDay(date));
  }
  for (const row of rows) {
    const hour = byHour.get(row.date);
    if (!hour) continue;
    if (row.kind === "scheduled") hour.scheduled = row.count;
    else if (row.kind === "event") hour.event = row.count;
    if (row.costUsd !== null && row.costUsd > 0) {
      hour.costUsd = addUsd(hour.costUsd, row.costUsd);
    }
  }
  return [...byHour.values()];
}

/** Load the newest terminal automation execution linked to one conversation, if any. */
export async function readAutomationExecutionByConversationId(args: {
  conversationId: string;
  namespace?: string;
}): Promise<
  { kind: AutomationExecutionType; automationId: string } | undefined
> {
  const namespace = args.namespace ?? "junior";
  const rows = await getDb()
    .select({
      kind: juniorAutomationExecutions.kind,
      automationId: juniorAutomationExecutions.automationId,
    })
    .from(juniorAutomationExecutions)
    .where(
      and(
        eq(juniorAutomationExecutions.conversationId, args.conversationId),
        eq(juniorAutomationExecutions.namespace, namespace),
        inArray(juniorAutomationExecutions.kind, [
          ...AUTOMATION_EXECUTION_TYPES,
        ]),
      ),
    )
    .orderBy(
      desc(juniorAutomationExecutions.executedAtMs),
      desc(juniorAutomationExecutions.executionId),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.kind !== "scheduled" && row.kind !== "event") return undefined;
  return { kind: row.kind, automationId: row.automationId };
}

/** Load newest-first executions for one automation, with conversation titles when present. */
export async function readAutomationExecutions(args: {
  kind: AutomationExecutionType;
  limit: number;
  namespace?: string;
  automationId: string;
}): Promise<AutomationExecutionRecord[]> {
  const namespace = args.namespace ?? "junior";
  const rows = await getDb()
    .select({
      conversationId: juniorAutomationExecutions.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorAutomationExecutions.executedAtMs,
      executionId: juniorAutomationExecutions.executionId,
      status: juniorAutomationExecutions.status,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorAutomationExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationExecutions.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorAutomationExecutions.kind, args.kind),
        eq(juniorAutomationExecutions.namespace, namespace),
        eq(juniorAutomationExecutions.automationId, args.automationId),
      ),
    )
    .orderBy(
      desc(juniorAutomationExecutions.executedAtMs),
      desc(juniorAutomationExecutions.executionId),
    )
    .limit(args.limit);
  return rows.map((row) => mapAutomationExecutionRecord(row));
}

/** Load newest-first executions for the supplied viewer-visible tasks. */
export async function readAutomationRuns(args: {
  conversationIds?: string[];
  limit: number;
  namespace?: string;
  automations?: Array<{ kind: AutomationExecutionType; automationId: string }>;
}): Promise<AutomationRunRecord[]> {
  const automations = args.automations ?? [];
  const conversationIds = [
    ...new Set(
      (args.conversationIds ?? []).filter(
        (conversationId) => conversationId.trim().length > 0,
      ),
    ),
  ];
  if (automations.length === 0 && conversationIds.length === 0) return [];
  const namespace = args.namespace ?? "junior";
  const selectors = [
    ...automations.map((task) =>
      and(
        eq(juniorAutomationExecutions.kind, task.kind),
        eq(juniorAutomationExecutions.automationId, task.automationId),
      ),
    ),
    ...(conversationIds.length > 0
      ? [inArray(juniorAutomationExecutions.conversationId, conversationIds)]
      : []),
  ];
  const rows = await getDb()
    .select({
      conversationId: juniorAutomationExecutions.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorAutomationExecutions.executedAtMs,
      executionId: juniorAutomationExecutions.executionId,
      kind: juniorAutomationExecutions.kind,
      status: juniorAutomationExecutions.status,
      automationId: juniorAutomationExecutions.automationId,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorAutomationExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorAutomationExecutions.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorAutomationExecutions.namespace, namespace),
        or(...selectors),
      ),
    )
    .orderBy(
      desc(juniorAutomationExecutions.executedAtMs),
      desc(juniorAutomationExecutions.executionId),
    )
    .limit(args.limit);
  return rows.flatMap((row) => {
    if (row.kind !== "scheduled" && row.kind !== "event") return [];
    return [
      {
        ...mapAutomationExecutionRecord(row),
        kind: row.kind,
        automationId: row.automationId,
      },
    ];
  });
}

function mapAutomationExecutionRecord(row: {
  conversationId: string | null;
  durationMs: number | null;
  executedAtMs: number;
  executionId: string;
  status: AutomationExecutionStatus;
  title: string | null;
  usage: Parameters<typeof agentTurnCostUsd>[0] | null;
}): AutomationExecutionRecord {
  const title = row.title?.trim();
  const costUsd = agentTurnCostUsd(row.usage ?? undefined);
  const totalTokens = agentTurnTotalTokens(row.usage ?? undefined);
  const durationMs =
    typeof row.durationMs === "number" &&
    Number.isFinite(row.durationMs) &&
    row.durationMs > 0
      ? row.durationMs
      : undefined;
  return {
    ...(row.conversationId
      ? { conversationId: row.conversationId }
      : undefined),
    ...(costUsd !== undefined ? { costUsd } : undefined),
    ...(durationMs !== undefined ? { durationMs } : undefined),
    executedAt: new Date(row.executedAtMs).toISOString(),
    executionId: row.executionId,
    status: row.status,
    ...(title ? { title } : undefined),
    ...(totalTokens !== undefined ? { totalTokens } : undefined),
  };
}

/** Load a fixed trailing window of terminal executions for one automation by status. */
export async function readAutomationExecutionStatusDays(args: {
  dayCount?: number;
  kind: AutomationExecutionType;
  namespace?: string;
  nowMs?: number;
  automationId: string;
}): Promise<AutomationExecutionStatusDay[]> {
  const dayCount = args.dayCount ?? 90;
  const namespace = args.namespace ?? "junior";
  const nowMs = args.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorAutomationExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await getDb()
    .select({
      count: count(),
      date: executionDate,
      status: juniorAutomationExecutions.status,
    })
    .from(juniorAutomationExecutions)
    .where(
      and(
        eq(juniorAutomationExecutions.kind, args.kind),
        eq(juniorAutomationExecutions.namespace, namespace),
        eq(juniorAutomationExecutions.automationId, args.automationId),
        gte(juniorAutomationExecutions.executedAtMs, startMs),
        lte(juniorAutomationExecutions.executedAtMs, endMs),
        inArray(juniorAutomationExecutions.status, [
          ...AUTOMATION_EXECUTION_STATUSES,
        ]),
      ),
    )
    .groupBy(executionDate, juniorAutomationExecutions.status)
    .orderBy(asc(executionDate), asc(juniorAutomationExecutions.status));

  const byDate = new Map<string, AutomationExecutionStatusDay>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = utcDate(startMs + offset * 86_400_000);
    byDate.set(date, emptyStatusDay(date));
  }
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) continue;
    if (row.status === "completed") day.completed = row.count;
    else if (row.status === "failed") day.failed = row.count;
    else if (row.status === "blocked") day.blocked = row.count;
  }
  return [...byDate.values()];
}

/** Load a fixed trailing window of terminal executions for one automation by hour. */
export async function readAutomationExecutionStatusHours(args: {
  hourCount?: number;
  kind: AutomationExecutionType;
  namespace?: string;
  nowMs?: number;
  automationId: string;
}): Promise<AutomationExecutionStatusDay[]> {
  const hourCount = args.hourCount ?? 7 * 24;
  const namespace = args.namespace ?? "junior";
  const nowMs = args.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorAutomationExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const rows = await getDb()
    .select({
      count: count(),
      date: executionHour,
      status: juniorAutomationExecutions.status,
    })
    .from(juniorAutomationExecutions)
    .where(
      and(
        eq(juniorAutomationExecutions.kind, args.kind),
        eq(juniorAutomationExecutions.namespace, namespace),
        eq(juniorAutomationExecutions.automationId, args.automationId),
        gte(juniorAutomationExecutions.executedAtMs, startMs),
        lte(juniorAutomationExecutions.executedAtMs, endMs),
        inArray(juniorAutomationExecutions.status, [
          ...AUTOMATION_EXECUTION_STATUSES,
        ]),
      ),
    )
    .groupBy(executionHour, juniorAutomationExecutions.status)
    .orderBy(asc(executionHour), asc(juniorAutomationExecutions.status));

  const byHour = new Map<string, AutomationExecutionStatusDay>();
  for (let offset = 0; offset < hourCount; offset += 1) {
    const date = new Date(startMs + offset * 3_600_000)
      .toISOString()
      .slice(0, 13);
    byHour.set(date, emptyStatusDay(date));
  }
  for (const row of rows) {
    const hour = byHour.get(row.date);
    if (!hour) continue;
    if (row.status === "completed") hour.completed = row.count;
    else if (row.status === "failed") hour.failed = row.count;
    else if (row.status === "blocked") hour.blocked = row.count;
  }
  return [...byHour.values()];
}
