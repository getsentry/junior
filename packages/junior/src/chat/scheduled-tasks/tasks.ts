import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations } from "@/db/schema/destinations";
import {
  juniorSchedulerRuns,
  juniorSchedulerTasks,
} from "@/db/schema/scheduled-tasks";
import {
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskRecord,
} from "./types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";
const retainedScheduledTaskSchema = scheduledTaskSchema
  .omit({ creatorIdentityId: true, title: true })
  .extend({
    // TODO(dcramer): Remove paused decoding and SQL list filtering after
    // v0.129.x workers are unsupported and cannot overlap an upgrade.
    status: z.enum(["active", "blocked", "completed", "deleted", "paused"]),
    version: z.number().optional(),
  })
  .strict();

type ScheduledTaskRow = Pick<
  typeof juniorSchedulerTasks.$inferSelect,
  "creatorIdentityId" | "record" | "title"
>;

/** Decode a retained scheduler task row and reject invalid routing context. */
export function parseScheduledTaskRow(
  row: ScheduledTaskRow,
): ScheduledTask | undefined {
  const record = z.record(z.string(), z.unknown()).safeParse(row.record);
  if (!record.success) return undefined;
  const {
    creatorIdentityId: legacyCreatorIdentityId,
    title: legacyTitle,
    ...retained
  } = record.data;
  const parsed = retainedScheduledTaskSchema.safeParse(retained);
  if (!parsed.success) return undefined;
  const { status, version: _version, ...task } = parsed.data;
  // The indexed identity remains authoritative while older workers may rewrite JSON.
  const fallbackIdentity =
    row.creatorIdentityId === null
      ? z.string().safeParse(legacyCreatorIdentityId)
      : undefined;
  const creatorIdentityId =
    row.creatorIdentityId ??
    (fallbackIdentity?.success ? fallbackIdentity.data : undefined);
  if (creatorIdentityId === undefined) return undefined;
  // A non-null indexed title stays authoritative during rolling deployment.
  const fallbackTitle =
    row.title === null ? z.string().safeParse(legacyTitle) : undefined;
  const titleSource =
    row.title !== null
      ? row.title
      : fallbackTitle?.success
        ? fallbackTitle.data
        : undefined;
  const title = titleSource?.trim() || undefined;
  if (status === "paused") {
    const {
      nextRunAtMs: _nextRunAtMs,
      runNowAtMs: _runNowAtMs,
      ...retained
    } = task;
    return {
      ...retained,
      creatorIdentityId,
      status: "deleted",
      ...(title ? { title } : undefined),
    } satisfies ScheduledTask;
  }
  return {
    ...task,
    creatorIdentityId,
    status,
    ...(title ? { title } : undefined),
  } satisfies ScheduledTask;
}

/** Keep scan paths from returning current or legacy tombstones. */
export function isListedScheduledTask(
  task: ScheduledTask | undefined,
): task is ScheduledTask {
  return task !== undefined && task.status !== "deleted";
}

/** Build the stable run id for one task occurrence. */
export function scheduledRunId(taskId: string, scheduledForMs: number): string {
  return `${taskId}:${scheduledForMs}`;
}

/** Acquire the deployed advisory lock for one scheduled task. */
export function withScheduledTaskLock<T>(
  db: JuniorDatabase,
  taskId: string,
  callback: (db: JuniorDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${SCHEDULER_KEY_PREFIX}:task:${taskId}:lock`}))`,
    );
    return await callback(tx);
  });
}

function requireStoredTask(task: ScheduledTask): ScheduledTask {
  const parsed = scheduledTaskSchema.safeParse(task);
  if (!parsed.success) {
    throw new Error("Scheduled task routing context is invalid.");
  }
  const { title, ...current } = parsed.data;
  const normalizedTitle = title?.trim() || undefined;
  return {
    ...current,
    ...(normalizedTitle ? { title: normalizedTitle } : undefined),
  };
}

function scheduledTaskJsonRecord(task: ScheduledTask): ScheduledTaskRecord {
  const { title: _title, ...record } = task;
  return record;
}

async function upsertScheduledTask(
  db: JuniorDatabase,
  task: ScheduledTask,
): Promise<void> {
  const title = task.title?.trim() || null;
  await db
    .insert(juniorSchedulerTasks)
    .values({
      createdAtMs: task.createdAtMs,
      creatorIdentityId: task.creatorIdentityId,
      // TODO(dcramer): Stop writing this column after v0.127.x runtimes are
      // unsupported and no supported runtime reads it.
      creatorSlackUserId: task.createdBy.slackUserId,
      id: task.id,
      nextRunAtMs: task.nextRunAtMs,
      record: scheduledTaskJsonRecord(task),
      runNowAtMs: task.runNowAtMs,
      status: task.status,
      teamId: task.destination.teamId,
      title,
    })
    .onConflictDoUpdate({
      target: juniorSchedulerTasks.id,
      set: {
        createdAtMs: sql`excluded.created_at_ms`,
        creatorIdentityId: sql`excluded.creator_identity_id`,
        creatorSlackUserId: sql`excluded.creator_slack_user_id`,
        nextRunAtMs: sql`excluded.next_run_at_ms`,
        record: sql`excluded.record`,
        runNowAtMs: sql`excluded.run_now_at_ms`,
        status: sql`excluded.status`,
        teamId: sql`excluded.team_id`,
        title: sql`excluded.title`,
      },
    });
}

/** Read and decode one scheduled task. */
export async function readScheduledTask(
  db: JuniorDatabase,
  taskId: string,
): Promise<ScheduledTask | undefined> {
  const rows = await db
    .select({
      creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
      record: juniorSchedulerTasks.record,
      title: juniorSchedulerTasks.title,
    })
    .from(juniorSchedulerTasks)
    .where(eq(juniorSchedulerTasks.id, taskId))
    .limit(1);
  return rows[0] ? parseScheduledTaskRow(rows[0]) : undefined;
}

async function readListedScheduledTasks(
  db: JuniorDatabase,
  teamId?: string,
): Promise<ScheduledTask[]> {
  const rows = await db
    .select({
      creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
      record: juniorSchedulerTasks.record,
      title: juniorSchedulerTasks.title,
    })
    .from(juniorSchedulerTasks)
    .where(
      and(
        notInArray(juniorSchedulerTasks.status, ["deleted", "paused"]),
        teamId === undefined
          ? undefined
          : eq(juniorSchedulerTasks.teamId, teamId),
      ),
    )
    .orderBy(
      asc(juniorSchedulerTasks.createdAtMs),
      asc(juniorSchedulerTasks.id),
    );
  return rows.map(parseScheduledTaskRow).filter(isListedScheduledTask);
}

/** List decoded scheduled tasks in stable creation order. */
export async function listScheduledTasks(
  db: JuniorDatabase,
): Promise<ScheduledTask[]> {
  return await readListedScheduledTasks(db);
}

/** List decoded scheduled tasks for one team in stable creation order. */
export async function listScheduledTasksForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<ScheduledTask[]> {
  return await readListedScheduledTasks(db, teamId);
}

async function writeScheduledTask(
  db: JuniorDatabase,
  task: ScheduledTask,
  current: ScheduledTask | undefined,
): Promise<void> {
  // Reactivation forgets the blocked slot so the same occurrence can dispatch.
  if (
    current?.status === "blocked" &&
    task.status === "active" &&
    typeof task.nextRunAtMs === "number" &&
    Number.isFinite(task.nextRunAtMs)
  ) {
    await db
      .delete(juniorSchedulerRuns)
      .where(
        and(
          eq(juniorSchedulerRuns.id, scheduledRunId(task.id, task.nextRunAtMs)),
          eq(juniorSchedulerRuns.status, "blocked"),
        ),
      );
  }
  await upsertScheduledTask(db, task);
}

/** Create a scheduled task once under its retry-stable task lock. */
export async function createScheduledTask(
  db: JuniorDatabase,
  task: ScheduledTask,
): Promise<ScheduledTask> {
  const next = requireStoredTask(task);
  return await withScheduledTaskLock(db, task.id, async (tx) => {
    const current = await readScheduledTask(tx, task.id);
    if (current) return current;
    await writeScheduledTask(tx, next, undefined);
    return next;
  });
}

/** Save a scheduled task and clear its blocked occurrence on reactivation. */
export async function saveScheduledTask(
  db: JuniorDatabase,
  task: ScheduledTask,
): Promise<ScheduledTask> {
  const next = requireStoredTask(task);
  await withScheduledTaskLock(db, task.id, async (tx) => {
    const current = await readScheduledTask(tx, task.id);
    await writeScheduledTask(tx, next, current);
  });
  return next;
}

/** Save a scheduled task inside a task lock already held by the caller. */
export async function saveScheduledTaskInLock(
  db: JuniorDatabase,
  task: ScheduledTask,
  current: ScheduledTask | undefined,
): Promise<void> {
  await writeScheduledTask(db, requireStoredTask(task), current);
}

/** List scheduled tasks whose current Slack destination is public. */
export async function listPublicScheduledTasksForTeams(
  db: JuniorDatabase,
  teamIds: string[],
  limit: number,
): Promise<ScheduledTask[]> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({
      creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
      record: juniorSchedulerTasks.record,
      title: juniorSchedulerTasks.title,
    })
    .from(juniorSchedulerTasks)
    .innerJoin(
      juniorDestinations,
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerTenantId, juniorSchedulerTasks.teamId),
        sql`${juniorDestinations.providerDestinationId} = ${juniorSchedulerTasks.record}->'destination'->>'channelId'`,
      ),
    )
    .where(
      and(
        inArray(juniorSchedulerTasks.teamId, teamIds),
        notInArray(juniorSchedulerTasks.status, [
          "completed",
          "deleted",
          "paused",
        ]),
        eq(juniorDestinations.visibility, "public"),
      ),
    )
    .orderBy(
      desc(juniorSchedulerTasks.createdAtMs),
      desc(juniorSchedulerTasks.id),
    )
    .limit(limit);
  return rows.map(parseScheduledTaskRow).filter(isListedScheduledTask);
}
