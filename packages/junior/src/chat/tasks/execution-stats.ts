import { and, asc, count, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { juniorTaskExecutions } from "@/db/schema";

export const TASK_EXECUTION_TYPES = [
  "registered",
  "scheduled",
  "event",
] as const;

export type TaskExecutionType = (typeof TASK_EXECUTION_TYPES)[number];

export type TaskExecutionDay = {
  date: string;
  event: number;
  registered: number;
  scheduled: number;
};

export type TaskExecutionSummary = {
  lastConversationId?: string;
  lastExecutedAtMs?: number;
  runsLast7Days: number;
  totalRuns: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyDay(date: string): TaskExecutionDay {
  return { date, event: 0, registered: 0, scheduled: 0 };
}

/** Record one successful task execution and its durable conversation. */
export async function recordTaskExecution(
  type: TaskExecutionType,
  taskId: string,
  options: {
    conversationId: string;
    executionId: string;
    namespace?: string;
    nowMs?: number;
  },
): Promise<void> {
  const namespace = options.namespace ?? "junior";
  const nowMs = options.nowMs ?? Date.now();
  try {
    await getDb()
      .insert(juniorTaskExecutions)
      .values({
        conversationId: options.conversationId,
        executedAtMs: nowMs,
        executionId: options.executionId,
        kind: type,
        namespace,
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
  const sevenDaysAgoMs =
    (options.nowMs ?? Date.now()) - 7 * 24 * 60 * 60 * 1000;
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
      runsLast7Days: sql<number>`count(*) filter (where ${juniorTaskExecutions.executedAtMs} >= ${sevenDaysAgoMs})::int`,
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
        lastConversationId: row.lastConversationId,
        ...(row.lastExecutedAtMs !== null
          ? { lastExecutedAtMs: row.lastExecutedAtMs }
          : {}),
        runsLast7Days: row.runsLast7Days,
        totalRuns: row.totalRuns,
      },
    ]),
  );
}

/** Load a fixed trailing window of successful executions stacked by task type. */
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
  const rows = await getDb()
    .select({
      count: count(),
      date: executionDate,
      kind: juniorTaskExecutions.kind,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        gte(juniorTaskExecutions.executedAtMs, startMs),
        lte(juniorTaskExecutions.executedAtMs, endMs),
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
    if (row.kind === "registered") day.registered = row.count;
    else if (row.kind === "scheduled") day.scheduled = row.count;
    else if (row.kind === "event") day.event = row.count;
  }
  return [...byDate.values()];
}
