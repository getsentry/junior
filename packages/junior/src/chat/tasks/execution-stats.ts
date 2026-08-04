import { and, asc, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import { logWarn } from "@/chat/logging";
import { juniorStats } from "@/db/schema";
import { incrementStat } from "@/stats";

export const TASK_EXECUTION_NAMESPACE = "junior";
export const TASK_EXECUTION_TYPES = [
  "registered",
  "scheduled",
  "event",
] as const;

export type TaskExecutionType = (typeof TASK_EXECUTION_TYPES)[number];

function taskExecutionMetric(type: TaskExecutionType): string {
  return `task.execution.${type}`;
}

export type TaskExecutionDay = {
  date: string;
  event: number;
  registered: number;
  scheduled: number;
};

function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function emptyDay(date: string): TaskExecutionDay {
  return { date, event: 0, registered: 0, scheduled: 0 };
}

/** Record one successful task execution into a per-task daily counter. */
export async function recordTaskExecution(
  type: TaskExecutionType,
  taskId: string,
  options: { namespace?: string; nowMs?: number } = {},
): Promise<void> {
  const namespace = options.namespace ?? TASK_EXECUTION_NAMESPACE;
  try {
    await incrementStat(
      {
        metric: taskExecutionMetric(type),
        name: taskId,
        namespace,
      },
      options,
    );
  } catch (error) {
    logWarn("task.execution.stat_failed", {
      error,
      "app.task.execution.id": taskId,
      "app.task.execution.namespace": namespace,
      "app.task.execution.type": type,
    });
  }
}

/** Load a fixed trailing window of daily task executions stacked by type. */
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
      count: sql<number>`sum(${juniorStats.count})::int`,
      date: juniorStats.date,
      metric: juniorStats.metric,
    })
    .from(juniorStats)
    .where(
      and(
        inArray(
          juniorStats.metric,
          TASK_EXECUTION_TYPES.map(taskExecutionMetric),
        ),
        gte(juniorStats.date, start),
        lte(juniorStats.date, end),
      ),
    )
    .groupBy(juniorStats.date, juniorStats.metric)
    .orderBy(asc(juniorStats.date), asc(juniorStats.metric));

  const byDate = new Map<string, TaskExecutionDay>();
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = utcDate(startMs + offset * 86_400_000);
    byDate.set(date, emptyDay(date));
  }
  for (const row of rows) {
    const day = byDate.get(row.date);
    if (!day) continue;
    if (row.metric === taskExecutionMetric("registered")) {
      day.registered = row.count;
    } else if (row.metric === taskExecutionMetric("scheduled")) {
      day.scheduled = row.count;
    } else if (row.metric === taskExecutionMetric("event")) {
      day.event = row.count;
    }
  }
  return [...byDate.values()];
}
