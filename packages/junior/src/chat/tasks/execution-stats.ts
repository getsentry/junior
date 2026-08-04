import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
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

/** Record one successful task execution in its daily analytics row. */
export async function recordTaskExecution(
  type: TaskExecutionType,
  taskId: string,
  options: { namespace?: string; nowMs?: number } = {},
): Promise<void> {
  const namespace = options.namespace ?? "junior";
  const nowMs = options.nowMs ?? Date.now();
  try {
    await getDb()
      .insert(juniorTaskExecutions)
      .values({
        count: 1,
        date: utcDate(nowMs),
        kind: type,
        lastExecutedAtMs: nowMs,
        namespace,
        taskId,
      })
      .onConflictDoUpdate({
        target: [
          juniorTaskExecutions.date,
          juniorTaskExecutions.kind,
          juniorTaskExecutions.namespace,
          juniorTaskExecutions.taskId,
        ],
        set: {
          count: sql`${juniorTaskExecutions.count} + 1`,
          lastExecutedAtMs: nowMs,
        },
      });
  } catch (error) {
    logWarn("task.execution.stat_failed", {
      error,
      "app.task.execution.id": taskId,
      "app.task.execution.namespace": namespace,
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
  const sevenDaysAgo = utcDate(
    (options.nowMs ?? Date.now()) - 6 * 24 * 60 * 60 * 1000,
  );
  const rows = await getDb()
    .select({
      lastExecutedAtMs: sql<number>`max(${juniorTaskExecutions.lastExecutedAtMs})::bigint`,
      runsLast7Days: sql<number>`coalesce(sum(${juniorTaskExecutions.count}) filter (where ${juniorTaskExecutions.date} >= ${sevenDaysAgo}), 0)::int`,
      taskId: juniorTaskExecutions.taskId,
      totalRuns: sql<number>`sum(${juniorTaskExecutions.count})::int`,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        eq(juniorTaskExecutions.kind, type),
        eq(juniorTaskExecutions.namespace, namespace),
      ),
    )
    .groupBy(juniorTaskExecutions.taskId);
  return new Map(
    rows.map((row) => [
      row.taskId,
      {
        lastExecutedAtMs: row.lastExecutedAtMs,
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
  const startMs =
    Date.parse(`${end}T00:00:00.000Z`) - (dayCount - 1) * 86_400_000;
  const start = utcDate(startMs);
  const rows = await getDb()
    .select({
      count: sql<number>`sum(${juniorTaskExecutions.count})::int`,
      date: juniorTaskExecutions.date,
      kind: juniorTaskExecutions.kind,
    })
    .from(juniorTaskExecutions)
    .where(
      and(
        gte(juniorTaskExecutions.date, start),
        lte(juniorTaskExecutions.date, end),
      ),
    )
    .groupBy(juniorTaskExecutions.date, juniorTaskExecutions.kind)
    .orderBy(asc(juniorTaskExecutions.date), asc(juniorTaskExecutions.kind));

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
