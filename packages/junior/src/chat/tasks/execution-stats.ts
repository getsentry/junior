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
  juniorTaskExecutions,
  type TaskExecutionStatus,
} from "@/db/schema/task-executions";

export const TASK_EXECUTION_TYPES = ["scheduled", "event"] as const;
export const TASK_EXECUTION_STATUSES = [
  "blocked",
  "completed",
  "failed",
] as const satisfies readonly TaskExecutionStatus[];

export type TaskExecutionType = (typeof TASK_EXECUTION_TYPES)[number];

export type TaskExecutionDay = {
  costUsd: number;
  date: string;
  event: number;
  scheduled: number;
};

function addUsd(current: number, next: number): number {
  return Math.round((current + next) * 1e12) / 1e12;
}

export type TaskRunWindows = {
  1: number;
  7: number;
  30: number;
  90: number;
};

export type TaskExecutionSummary = {
  lastConversationId?: string;
  lastExecutedAtMs?: number;
  runs: TaskRunWindows;
  totalRuns: number;
};

const EMPTY_RUN_WINDOWS: TaskRunWindows = { 1: 0, 7: 0, 30: 0, 90: 0 };

/** Empty run windows for tasks with no execution history. */
export function emptyTaskRunWindows(): TaskRunWindows {
  return { ...EMPTY_RUN_WINDOWS };
}

export type TaskExecutionRecord = {
  conversationId?: string;
  costUsd?: number;
  durationMs?: number;
  executedAt: string;
  executionId: string;
  status: TaskExecutionStatus;
  title?: string;
  totalTokens?: number;
};

export type TaskRunRecord = TaskExecutionRecord & {
  kind: TaskExecutionType;
  taskId: string;
};

export type TaskExecutionStatusDay = {
  blocked: number;
  completed: number;
  date: string;
  failed: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyDay(date: string): TaskExecutionDay {
  return { costUsd: 0, date, event: 0, scheduled: 0 };
}

function emptyStatusDay(date: string): TaskExecutionStatusDay {
  return { blocked: 0, completed: 0, date, failed: 0 };
}

/** Record one terminal task execution and its durable conversation when present. */
export async function recordTaskExecution(
  type: TaskExecutionType,
  taskId: string,
  options: {
    conversationId?: string;
    executionId: string;
    namespace?: string;
    nowMs?: number;
    status?: TaskExecutionStatus;
  },
): Promise<void> {
  const namespace = options.namespace ?? "junior";
  const nowMs = options.nowMs ?? Date.now();
  const status = options.status ?? "completed";
  try {
    await getDb()
      .insert(juniorTaskExecutions)
      .values({
        ...(options.conversationId
          ? { conversationId: options.conversationId }
          : undefined),
        executedAtMs: nowMs,
        executionId: options.executionId,
        kind: type,
        namespace,
        status,
        taskId,
      })
      .onConflictDoNothing({
        target: [
          juniorTaskExecutions.kind,
          juniorTaskExecutions.namespace,
          juniorTaskExecutions.executionId,
        ],
      });
  } catch (error) {
    logWarn("task.execution.stat_failed", {
      error,
      "app.task.execution.id": options.executionId,
      "app.task.execution.namespace": namespace,
      "app.task.execution.status": status,
      "app.task.execution.task_id": taskId,
      "app.task.execution.type": type,
    });
  }
}

/** Load usage analytics for all tasks of one type and namespace. */
export async function readTaskExecutionSummaries(
  type: TaskExecutionType,
  namespace: string,
  options: { nowMs?: number } = {},
): Promise<Map<string, TaskExecutionSummary>> {
  const nowMs = options.nowMs ?? Date.now();
  const oneDayAgoMs = nowMs - 1 * 24 * 60 * 60 * 1000;
  const sevenDaysAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgoMs = nowMs - 30 * 24 * 60 * 60 * 1000;
  const ninetyDaysAgoMs = nowMs - 90 * 24 * 60 * 60 * 1000;
  const db = getDb();
  const latest = db
    .selectDistinctOn([juniorTaskExecutions.taskId], {
      conversationId: juniorTaskExecutions.conversationId,
      taskId: juniorTaskExecutions.taskId,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        eq(juniorTaskExecutions.kind, type),
        eq(juniorTaskExecutions.namespace, namespace),
      ),
    )
    .orderBy(
      juniorTaskExecutions.taskId,
      desc(juniorTaskExecutions.executedAtMs),
      desc(juniorTaskExecutions.executionId),
    )
    .as("latest_task_execution");
  const rows = await db
    .select({
      lastConversationId: latest.conversationId,
      lastExecutedAtMs: max(juniorTaskExecutions.executedAtMs),
      runsLast1Day: sql<number>`count(*) filter (where ${juniorTaskExecutions.executedAtMs} >= ${oneDayAgoMs})::int`,
      runsLast7Days: sql<number>`count(*) filter (where ${juniorTaskExecutions.executedAtMs} >= ${sevenDaysAgoMs})::int`,
      runsLast30Days: sql<number>`count(*) filter (where ${juniorTaskExecutions.executedAtMs} >= ${thirtyDaysAgoMs})::int`,
      runsLast90Days: sql<number>`count(*) filter (where ${juniorTaskExecutions.executedAtMs} >= ${ninetyDaysAgoMs})::int`,
      taskId: juniorTaskExecutions.taskId,
      totalRuns: sql<number>`count(*)::int`,
    })
    .from(juniorTaskExecutions)
    .innerJoin(latest, eq(latest.taskId, juniorTaskExecutions.taskId))
    .where(
      and(
        eq(juniorTaskExecutions.kind, type),
        eq(juniorTaskExecutions.namespace, namespace),
      ),
    )
    .groupBy(juniorTaskExecutions.taskId, latest.conversationId);
  return new Map(
    rows.map((row) => [
      row.taskId,
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
export async function readTaskExecutionDays(
  dayCount = 90,
  options: { nowMs?: number } = {},
): Promise<TaskExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorTaskExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  const rows = await getDb()
    .select({
      count: count(),
      costUsd: sql<number | null>`SUM(${conversationCost})::double precision`,
      date: executionDate,
      kind: juniorTaskExecutions.kind,
    })
    .from(juniorTaskExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorTaskExecutions.conversationId,
      ),
    )
    .where(
      and(
        gte(juniorTaskExecutions.executedAtMs, startMs),
        lte(juniorTaskExecutions.executedAtMs, endMs),
        eq(juniorTaskExecutions.status, "completed"),
      ),
    )
    .groupBy(executionDate, juniorTaskExecutions.kind)
    .orderBy(asc(executionDate), asc(juniorTaskExecutions.kind));

  const byDate = new Map<string, TaskExecutionDay>();
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
export async function readTaskExecutionHours(
  hourCount = 24,
  options: { nowMs?: number } = {},
): Promise<TaskExecutionDay[]> {
  const nowMs = options.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorTaskExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const conversationCost = conversationUsageCostExpr(juniorConversations.usage);
  const rows = await getDb()
    .select({
      count: count(),
      costUsd: sql<number | null>`SUM(${conversationCost})::double precision`,
      date: executionHour,
      kind: juniorTaskExecutions.kind,
    })
    .from(juniorTaskExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorTaskExecutions.conversationId,
      ),
    )
    .where(
      and(
        gte(juniorTaskExecutions.executedAtMs, startMs),
        lte(juniorTaskExecutions.executedAtMs, endMs),
        eq(juniorTaskExecutions.status, "completed"),
      ),
    )
    .groupBy(executionHour, juniorTaskExecutions.kind)
    .orderBy(asc(executionHour), asc(juniorTaskExecutions.kind));

  const byHour = new Map<string, TaskExecutionDay>();
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

/** Load the newest terminal task execution linked to one conversation, if any. */
export async function readTaskExecutionByConversationId(args: {
  conversationId: string;
  namespace?: string;
}): Promise<{ kind: TaskExecutionType; taskId: string } | undefined> {
  const namespace = args.namespace ?? "junior";
  const rows = await getDb()
    .select({
      kind: juniorTaskExecutions.kind,
      taskId: juniorTaskExecutions.taskId,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        eq(juniorTaskExecutions.conversationId, args.conversationId),
        eq(juniorTaskExecutions.namespace, namespace),
        inArray(juniorTaskExecutions.kind, [...TASK_EXECUTION_TYPES]),
      ),
    )
    .orderBy(
      desc(juniorTaskExecutions.executedAtMs),
      desc(juniorTaskExecutions.executionId),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (row.kind !== "scheduled" && row.kind !== "event") return undefined;
  return { kind: row.kind, taskId: row.taskId };
}

/** Load newest-first executions for one task, with conversation titles when present. */
export async function readTaskExecutions(args: {
  kind: TaskExecutionType;
  limit: number;
  namespace?: string;
  taskId: string;
}): Promise<TaskExecutionRecord[]> {
  const namespace = args.namespace ?? "junior";
  const rows = await getDb()
    .select({
      conversationId: juniorTaskExecutions.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorTaskExecutions.executedAtMs,
      executionId: juniorTaskExecutions.executionId,
      status: juniorTaskExecutions.status,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorTaskExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorTaskExecutions.conversationId,
      ),
    )
    .where(
      and(
        eq(juniorTaskExecutions.kind, args.kind),
        eq(juniorTaskExecutions.namespace, namespace),
        eq(juniorTaskExecutions.taskId, args.taskId),
      ),
    )
    .orderBy(
      desc(juniorTaskExecutions.executedAtMs),
      desc(juniorTaskExecutions.executionId),
    )
    .limit(args.limit);
  return rows.map((row) => mapTaskExecutionRecord(row));
}

/** Load newest-first executions for the supplied viewer-visible tasks. */
export async function readTaskRuns(args: {
  conversationIds?: string[];
  limit: number;
  namespace?: string;
  tasks?: Array<{ kind: TaskExecutionType; taskId: string }>;
}): Promise<TaskRunRecord[]> {
  const tasks = args.tasks ?? [];
  const conversationIds = [
    ...new Set(
      (args.conversationIds ?? []).filter(
        (conversationId) => conversationId.trim().length > 0,
      ),
    ),
  ];
  if (tasks.length === 0 && conversationIds.length === 0) return [];
  const namespace = args.namespace ?? "junior";
  const selectors = [
    ...tasks.map((task) =>
      and(
        eq(juniorTaskExecutions.kind, task.kind),
        eq(juniorTaskExecutions.taskId, task.taskId),
      ),
    ),
    ...(conversationIds.length > 0
      ? [inArray(juniorTaskExecutions.conversationId, conversationIds)]
      : []),
  ];
  const rows = await getDb()
    .select({
      conversationId: juniorTaskExecutions.conversationId,
      durationMs: juniorConversations.durationMs,
      executedAtMs: juniorTaskExecutions.executedAtMs,
      executionId: juniorTaskExecutions.executionId,
      kind: juniorTaskExecutions.kind,
      status: juniorTaskExecutions.status,
      taskId: juniorTaskExecutions.taskId,
      title: juniorConversations.title,
      usage: juniorConversations.usage,
    })
    .from(juniorTaskExecutions)
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorTaskExecutions.conversationId,
      ),
    )
    .where(and(eq(juniorTaskExecutions.namespace, namespace), or(...selectors)))
    .orderBy(
      desc(juniorTaskExecutions.executedAtMs),
      desc(juniorTaskExecutions.executionId),
    )
    .limit(args.limit);
  return rows.flatMap((row) => {
    if (row.kind !== "scheduled" && row.kind !== "event") return [];
    return [
      {
        ...mapTaskExecutionRecord(row),
        kind: row.kind,
        taskId: row.taskId,
      },
    ];
  });
}

function mapTaskExecutionRecord(row: {
  conversationId: string | null;
  durationMs: number | null;
  executedAtMs: number;
  executionId: string;
  status: TaskExecutionStatus;
  title: string | null;
  usage: Parameters<typeof agentTurnCostUsd>[0] | null;
}): TaskExecutionRecord {
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

/** Load a fixed trailing window of terminal executions for one task by status. */
export async function readTaskExecutionStatusDays(args: {
  dayCount?: number;
  kind: TaskExecutionType;
  namespace?: string;
  nowMs?: number;
  taskId: string;
}): Promise<TaskExecutionStatusDay[]> {
  const dayCount = args.dayCount ?? 90;
  const namespace = args.namespace ?? "junior";
  const nowMs = args.nowMs ?? Date.now();
  const end = utcDate(nowMs);
  const endMs = Date.parse(`${end}T23:59:59.999Z`);
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const executionDate = sql<string>`to_char(to_timestamp(${juniorTaskExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await getDb()
    .select({
      count: count(),
      date: executionDate,
      status: juniorTaskExecutions.status,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        eq(juniorTaskExecutions.kind, args.kind),
        eq(juniorTaskExecutions.namespace, namespace),
        eq(juniorTaskExecutions.taskId, args.taskId),
        gte(juniorTaskExecutions.executedAtMs, startMs),
        lte(juniorTaskExecutions.executedAtMs, endMs),
        inArray(juniorTaskExecutions.status, [...TASK_EXECUTION_STATUSES]),
      ),
    )
    .groupBy(executionDate, juniorTaskExecutions.status)
    .orderBy(asc(executionDate), asc(juniorTaskExecutions.status));

  const byDate = new Map<string, TaskExecutionStatusDay>();
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

/** Load a fixed trailing window of terminal executions for one task by hour. */
export async function readTaskExecutionStatusHours(args: {
  hourCount?: number;
  kind: TaskExecutionType;
  namespace?: string;
  nowMs?: number;
  taskId: string;
}): Promise<TaskExecutionStatusDay[]> {
  const hourCount = args.hourCount ?? 24;
  const namespace = args.namespace ?? "junior";
  const nowMs = args.nowMs ?? Date.now();
  const end = new Date(nowMs);
  end.setUTCMinutes(0, 0, 0);
  const endMs = end.getTime() + 3_599_999;
  const startMs = end.getTime() - (hourCount - 1) * 3_600_000;
  const executionHour = sql<string>`to_char(to_timestamp(${juniorTaskExecutions.executedAtMs} / 1000.0) at time zone 'UTC', 'YYYY-MM-DD"T"HH24')`;
  const rows = await getDb()
    .select({
      count: count(),
      date: executionHour,
      status: juniorTaskExecutions.status,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        eq(juniorTaskExecutions.kind, args.kind),
        eq(juniorTaskExecutions.namespace, namespace),
        eq(juniorTaskExecutions.taskId, args.taskId),
        gte(juniorTaskExecutions.executedAtMs, startMs),
        lte(juniorTaskExecutions.executedAtMs, endMs),
        inArray(juniorTaskExecutions.status, [...TASK_EXECUTION_STATUSES]),
      ),
    )
    .groupBy(executionHour, juniorTaskExecutions.status)
    .orderBy(asc(executionHour), asc(juniorTaskExecutions.status));

  const byHour = new Map<string, TaskExecutionStatusDay>();
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
