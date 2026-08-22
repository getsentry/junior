import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getNextRunAtMs } from "./cadence";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorSchedulerRuns,
  juniorSchedulerTasks,
} from "@/db/schema/scheduled-tasks";
import {
  listScheduledTasks,
  listScheduledTasksForTeam,
  readScheduledTask,
  saveScheduledTaskInLock,
  scheduledRunId,
  withScheduledTaskLock,
} from "./tasks";
import { logScheduledTaskRunSkipped } from "./telemetry";
import {
  scheduledRunSchema,
  type ScheduledRun,
  type ScheduledTask,
  type ScheduledTaskStatus,
} from "./types";

const PENDING_CLAIM_STALE_MS = 60_000;
const MISSED_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INCOMPLETE_RUN_STATUSES = ["pending", "running"] as const;
const retainedScheduledRunSchema = scheduledRunSchema
  .extend({
    idempotencyKey: z.string().optional(),
    taskVersion: z.number().optional(),
  })
  .strict();

type ScheduledRunRow = Pick<typeof juniorSchedulerRuns.$inferSelect, "record">;
type SkippedRunTelemetry = {
  errorMessage: string;
  run: ScheduledRun;
  task: ScheduledTask;
};

/** Decode a scheduler run row and remove retained legacy fields. */
function parseScheduledRunRow(row: ScheduledRunRow): ScheduledRun | undefined {
  const parsed = retainedScheduledRunSchema.safeParse(row.record);
  if (!parsed.success) return undefined;
  const {
    idempotencyKey: _idempotencyKey,
    taskVersion: _taskVersion,
    ...run
  } = parsed.data;
  return run;
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function readRun(
  db: JuniorDatabase,
  runId: string,
): Promise<ScheduledRun | undefined> {
  const rows = await db
    .select({ record: juniorSchedulerRuns.record })
    .from(juniorSchedulerRuns)
    .where(eq(juniorSchedulerRuns.id, runId))
    .limit(1);
  return rows[0] ? parseScheduledRunRow(rows[0]) : undefined;
}

async function writeRun(db: JuniorDatabase, run: ScheduledRun): Promise<void> {
  const stored = scheduledRunSchema.parse(run);
  await db
    .insert(juniorSchedulerRuns)
    .values({
      id: stored.id,
      record: stored,
      scheduledForMs: stored.scheduledForMs,
      status: stored.status,
      taskId: stored.taskId,
    })
    .onConflictDoUpdate({
      target: juniorSchedulerRuns.id,
      set: {
        record: sql`excluded.record`,
        scheduledForMs: sql`excluded.scheduled_for_ms`,
        status: sql`excluded.status`,
        taskId: sql`excluded.task_id`,
      },
    });
}

async function listIncompleteRunsForTaskIds(
  db: JuniorDatabase,
  taskIds: string[],
): Promise<ScheduledRun[]> {
  if (taskIds.length === 0) return [];
  const rows = await db
    .select({ record: juniorSchedulerRuns.record })
    .from(juniorSchedulerRuns)
    .where(
      and(
        inArray(juniorSchedulerRuns.taskId, taskIds),
        inArray(juniorSchedulerRuns.status, [...INCOMPLETE_RUN_STATUSES]),
      ),
    )
    .orderBy(
      asc(juniorSchedulerRuns.scheduledForMs),
      asc(juniorSchedulerRuns.id),
    );
  return rows.map(parseScheduledRunRow).filter(present);
}

/** List incomplete runs for retained scheduled tasks. */
export async function listIncompleteScheduledRuns(
  db: JuniorDatabase,
): Promise<ScheduledRun[]> {
  const tasks = await listScheduledTasks(db);
  return await listIncompleteRunsForTaskIds(
    db,
    tasks.map((task) => task.id),
  );
}

function getDueRunAtMs(task: ScheduledTask, nowMs: number): number | undefined {
  if (
    typeof task.runNowAtMs === "number" &&
    Number.isFinite(task.runNowAtMs) &&
    task.runNowAtMs <= nowMs
  ) {
    return task.runNowAtMs;
  }
  if (
    typeof task.nextRunAtMs === "number" &&
    Number.isFinite(task.nextRunAtMs) &&
    task.nextRunAtMs <= nowMs
  ) {
    return task.nextRunAtMs;
  }
  return undefined;
}

function isStalePendingRun(
  run: ScheduledRun | undefined,
  nowMs: number,
): boolean {
  return (
    run?.status === "pending" &&
    run.claimedAtMs + PENDING_CLAIM_STALE_MS <= nowMs
  );
}

function normalizedText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? "";
}

function taskDedupeFingerprint(task: ScheduledTask): string {
  return JSON.stringify({
    credentialMode: task.credentialMode,
    credentialUserId:
      task.credentialMode === "creator" ? task.createdBy.slackUserId : null,
    destination: task.destination,
    schedule: {
      kind: task.schedule.kind,
      oneOffAtMs: task.schedule.kind === "one_off" ? task.nextRunAtMs : null,
      recurrence: task.schedule.recurrence
        ? {
            dayOfMonth: task.schedule.recurrence.dayOfMonth ?? null,
            frequency: task.schedule.recurrence.frequency,
            interval: task.schedule.recurrence.interval,
            month: task.schedule.recurrence.month ?? null,
            startDate: task.schedule.recurrence.startDate,
            time: task.schedule.recurrence.time,
            weekdays: [...(task.schedule.recurrence.weekdays ?? [])].sort(),
          }
        : null,
      timezone: task.schedule.timezone,
    },
    task: normalizedText(task.task.text),
  });
}

async function findStaleRecoveryCanonicalTask(
  db: JuniorDatabase,
  task: ScheduledTask,
): Promise<ScheduledTask | undefined> {
  const fingerprint = taskDedupeFingerprint(task);
  return (await listScheduledTasksForTeam(db, task.destination.teamId))
    .filter(
      (candidate) =>
        candidate.id !== task.id &&
        candidate.status === "active" &&
        (candidate.createdAtMs < task.createdAtMs ||
          (candidate.createdAtMs === task.createdAtMs &&
            candidate.id < task.id)) &&
        taskDedupeFingerprint(candidate) === fingerprint,
    )
    .at(0);
}

function statusAfterTerminalOccurrence(args: {
  nextRunAtMs: number | undefined;
  outcome?: "blocked" | "completed" | "failed";
  previousStatus?: ScheduledTaskStatus;
}): ScheduledTaskStatus {
  if (args.outcome === "blocked") return "blocked";
  if (args.nextRunAtMs) return args.previousStatus ?? "active";
  if (args.outcome === "completed") return "completed";
  return "deleted";
}

async function skipMissedRun(
  db: JuniorDatabase,
  args: {
    nowMs: number;
    scheduledForMs: number;
    task: ScheduledTask;
  },
): Promise<SkippedRunTelemetry | undefined> {
  const current = args.task;
  if (
    current.status !== "active" ||
    getDueRunAtMs(current, args.nowMs) !== args.scheduledForMs
  ) {
    return undefined;
  }
  const duplicateOf = await findStaleRecoveryCanonicalTask(db, current);
  const errorMessage = duplicateOf
    ? `Duplicate stale scheduled task was skipped without dispatch. Canonical task: ${duplicateOf.id}.`
    : "Scheduled occurrence was more than 24 hours late and was skipped without dispatch.";
  const skipped: ScheduledRun = {
    id: scheduledRunId(current.id, args.scheduledForMs),
    attempt: 1,
    claimedAtMs: args.nowMs,
    completedAtMs: args.nowMs,
    errorMessage,
    scheduledForMs: args.scheduledForMs,
    status: "skipped",
    taskId: current.id,
  };
  await writeRun(db, skipped);
  const isRunNow = current.runNowAtMs === args.scheduledForMs;
  let nextRunAtMs: number | undefined;
  if (!duplicateOf) {
    nextRunAtMs =
      isRunNow && current.nextRunAtMs !== args.scheduledForMs
        ? current.nextRunAtMs
        : current.schedule.kind === "recurring"
          ? getNextRunAtMs(current, args.scheduledForMs, args.nowMs)
          : undefined;
  }
  const status = statusAfterTerminalOccurrence({ nextRunAtMs });
  await saveScheduledTaskInLock(
    db,
    {
      ...current,
      nextRunAtMs,
      runNowAtMs: isRunNow ? undefined : current.runNowAtMs,
      status,
      statusReason: status === "deleted" ? errorMessage : undefined,
      updatedAtMs: args.nowMs,
    },
    current,
  );
  return { errorMessage, run: skipped, task: current };
}

/** Claim one due scheduler run under the deployed global claim lock. */
export async function claimDueScheduledRun(
  db: JuniorDatabase,
  args: { nowMs: number },
): Promise<ScheduledRun | undefined> {
  const skippedRuns: SkippedRunTelemetry[] = [];
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('junior:scheduler:claim'))`,
    );
    const rows = await tx
      .select({ id: juniorSchedulerTasks.id })
      .from(juniorSchedulerTasks)
      .where(
        and(
          eq(juniorSchedulerTasks.status, "active"),
          or(
            and(
              isNotNull(juniorSchedulerTasks.runNowAtMs),
              lte(juniorSchedulerTasks.runNowAtMs, args.nowMs),
            ),
            and(
              isNotNull(juniorSchedulerTasks.nextRunAtMs),
              lte(juniorSchedulerTasks.nextRunAtMs, args.nowMs),
            ),
          ),
        ),
      )
      .orderBy(
        asc(juniorSchedulerTasks.createdAtMs),
        asc(juniorSchedulerTasks.id),
      );

    for (const row of rows) {
      const run = await withScheduledTaskLock(tx, row.id, async (taskTx) => {
        const task = await readScheduledTask(taskTx, row.id);
        if (!task || task.status !== "active") return undefined;
        const scheduledForMs = getDueRunAtMs(task, args.nowMs);
        if (scheduledForMs === undefined) return undefined;
        const runId = scheduledRunId(task.id, scheduledForMs);
        const incompleteRuns = await listIncompleteRunsForTaskIds(taskTx, [
          task.id,
        ]);
        const incompleteRun = incompleteRuns.find((item) => item.id === runId);
        const blockingRun = incompleteRuns.find(
          (item) => item.id !== runId && !isStalePendingRun(item, args.nowMs),
        );
        if (blockingRun) return undefined;
        if (incompleteRun) {
          if (!isStalePendingRun(incompleteRun, args.nowMs)) return undefined;
          const reclaimed = {
            ...incompleteRun,
            attempt: incompleteRun.attempt + 1,
            claimedAtMs: args.nowMs,
          };
          await writeRun(taskTx, reclaimed);
          return reclaimed;
        }
        if (await readRun(taskTx, runId)) return undefined;
        if (scheduledForMs + MISSED_RUN_MAX_AGE_MS < args.nowMs) {
          const skipped = await skipMissedRun(taskTx, {
            nowMs: args.nowMs,
            scheduledForMs,
            task,
          });
          if (skipped) skippedRuns.push(skipped);
          return undefined;
        }
        const next: ScheduledRun = {
          id: runId,
          attempt: 1,
          claimedAtMs: args.nowMs,
          scheduledForMs,
          status: "pending",
          taskId: task.id,
        };
        await writeRun(taskTx, next);
        return next;
      });
      if (run) return run;
    }
    return undefined;
  });
  for (const skipped of skippedRuns) {
    logScheduledTaskRunSkipped(skipped.task, skipped.run, {
      "app.task.run.error": skipped.errorMessage,
    });
  }
  return claimed;
}

async function updateRun(
  db: JuniorDatabase,
  runId: string,
  update: (run: ScheduledRun) => ScheduledRun | undefined,
): Promise<ScheduledRun | undefined> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`junior:scheduler:run:${runId}:lock`}))`,
    );
    const current = await readRun(tx, runId);
    if (!current) return undefined;
    const next = update(current);
    if (!next) return undefined;
    await writeRun(tx, next);
    return next;
  });
}

function canFinishRun(
  run: ScheduledRun,
  startedAtMs: number | undefined,
): boolean {
  if (run.status === "pending") return startedAtMs === undefined;
  return run.status === "running" && run.startedAtMs === startedAtMs;
}

/** Mark a pending run dispatched only for the active claim. */
export async function markScheduledRunDispatched(
  db: JuniorDatabase,
  args: {
    claimedAtMs: number;
    dispatchId: string;
    nowMs: number;
    runId: string;
  },
): Promise<ScheduledRun | undefined> {
  return await updateRun(db, args.runId, (run) =>
    run.status === "pending" && run.claimedAtMs === args.claimedAtMs
      ? {
          ...run,
          dispatchId: args.dispatchId,
          startedAtMs: args.nowMs,
          status: "running",
        }
      : undefined,
  );
}

/** Complete a run only for its active start timestamp. */
export async function markScheduledRunCompleted(
  db: JuniorDatabase,
  args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
    startedAtMs: number;
  },
): Promise<ScheduledRun | undefined> {
  return await updateRun(db, args.runId, (run) =>
    canFinishRun(run, args.startedAtMs)
      ? {
          ...run,
          completedAtMs: args.completedAtMs,
          resultMessageTs: args.resultMessageTs,
          status: "completed",
        }
      : undefined,
  );
}

/** Fail a claimed or running run only for its active transition guard. */
export async function markScheduledRunFailed(
  db: JuniorDatabase,
  args: {
    completedAtMs: number;
    errorMessage: string;
    startedAtMs?: number;
    runId: string;
  },
): Promise<ScheduledRun | undefined> {
  return await updateRun(db, args.runId, (run) =>
    canFinishRun(run, args.startedAtMs)
      ? {
          ...run,
          completedAtMs: args.completedAtMs,
          errorMessage: args.errorMessage,
          status: "failed",
        }
      : undefined,
  );
}

/** Block a claimed or running run only for its active transition guard. */
export async function markScheduledRunBlocked(
  db: JuniorDatabase,
  args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
    startedAtMs?: number;
  },
): Promise<ScheduledRun | undefined> {
  return await updateRun(db, args.runId, (run) =>
    canFinishRun(run, args.startedAtMs)
      ? {
          ...run,
          completedAtMs: args.completedAtMs,
          errorMessage: args.errorMessage,
          status: "blocked",
        }
      : undefined,
  );
}

/** Skip a pending run only before dispatch begins. */
export async function markScheduledRunSkipped(
  db: JuniorDatabase,
  args: { completedAtMs: number; errorMessage: string; runId: string },
): Promise<ScheduledRun | undefined> {
  return await updateRun(db, args.runId, (run) =>
    run.status === "pending"
      ? {
          ...run,
          completedAtMs: args.completedAtMs,
          errorMessage: args.errorMessage,
          status: "skipped",
        }
      : undefined,
  );
}

/** Advance a scheduled task after a terminal run under its task lock. */
export async function advanceScheduledTaskAfterRun(
  db: JuniorDatabase,
  args: {
    errorMessage?: string;
    nowMs: number;
    run: ScheduledRun;
    status: "blocked" | "completed" | "failed";
  },
): Promise<void> {
  await withScheduledTaskLock(db, args.run.taskId, async (tx) => {
    const current = await readScheduledTask(tx, args.run.taskId);
    if (
      !current ||
      current.status === "deleted" ||
      current.status === "completed"
    ) {
      return;
    }
    const isRunNow = current.runNowAtMs === args.run.scheduledForMs;
    if (isRunNow) {
      let nextRunAtMs = current.nextRunAtMs;
      if (
        args.status !== "blocked" &&
        typeof current.nextRunAtMs === "number" &&
        current.nextRunAtMs <= args.run.scheduledForMs
      ) {
        nextRunAtMs = getNextRunAtMs(current, current.nextRunAtMs, args.nowMs);
      }
      await saveScheduledTaskInLock(
        tx,
        {
          ...current,
          lastRunAtMs: args.run.scheduledForMs,
          nextRunAtMs,
          runNowAtMs: undefined,
          status: statusAfterTerminalOccurrence({
            nextRunAtMs,
            outcome: args.status,
            previousStatus: current.status,
          }),
          statusReason:
            args.status === "blocked" ? args.errorMessage : undefined,
          updatedAtMs: args.nowMs,
        },
        current,
      );
      return;
    }
    if (
      current.status !== "active" ||
      current.nextRunAtMs !== args.run.scheduledForMs
    ) {
      await saveScheduledTaskInLock(
        tx,
        {
          ...current,
          lastRunAtMs: args.run.scheduledForMs,
          updatedAtMs: args.nowMs,
        },
        current,
      );
      return;
    }
    const nextRunAtMs =
      args.status === "blocked"
        ? undefined
        : getNextRunAtMs(current, args.run.scheduledForMs, args.nowMs);
    await saveScheduledTaskInLock(
      tx,
      {
        ...current,
        lastRunAtMs: args.run.scheduledForMs,
        nextRunAtMs,
        status: statusAfterTerminalOccurrence({
          nextRunAtMs,
          outcome: args.status,
        }),
        statusReason: args.status === "blocked" ? args.errorMessage : undefined,
        updatedAtMs: args.nowMs,
      },
      current,
    );
  });
}
