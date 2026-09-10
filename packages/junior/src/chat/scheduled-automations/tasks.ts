import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { JuniorDatabase } from "@/db/db";
import { juniorDestinations } from "@/db/schema/destinations";
import {
  juniorSchedulerRuns,
  juniorSchedulerTasks,
} from "@/db/schema/scheduled-automations";
import {
  scheduledRunSchema,
  scheduledAutomationSchema,
  type ScheduledAutomation,
  type ScheduledAutomationRecord,
} from "./types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";
const retainedScheduledAutomationSchema = scheduledAutomationSchema
  .omit({ creatorIdentityId: true, title: true })
  .extend({
    // TODO(dcramer): Remove paused decoding and SQL list filtering after
    // v0.129.x workers are unsupported and cannot overlap an upgrade.
    status: z.enum(["active", "blocked", "completed", "deleted", "paused"]),
    version: z.number().optional(),
  })
  .strict();

type ScheduledAutomationRow = Pick<
  typeof juniorSchedulerTasks.$inferSelect,
  "creatorIdentityId" | "record" | "title"
>;

/** Decode a retained scheduler task row and reject invalid routing context. */
export function parseScheduledAutomationRow(
  row: ScheduledAutomationRow,
): ScheduledAutomation | undefined {
  const record = z.record(z.string(), z.unknown()).safeParse(row.record);
  if (!record.success) return undefined;
  const {
    creatorIdentityId: legacyCreatorIdentityId,
    title: legacyTitle,
    ...retained
  } = record.data;
  const parsed = retainedScheduledAutomationSchema.safeParse(retained);
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
    } satisfies ScheduledAutomation;
  }
  return {
    ...task,
    creatorIdentityId,
    status,
    ...(title ? { title } : undefined),
  } satisfies ScheduledAutomation;
}

/** Keep scan paths from returning current or legacy tombstones. */
export function isListedScheduledAutomation(
  task: ScheduledAutomation | undefined,
): task is ScheduledAutomation {
  return task !== undefined && task.status !== "deleted";
}

/** Build the stable run id for one task occurrence. */
export function scheduledRunId(taskId: string, scheduledForMs: number): string {
  return `${taskId}:${scheduledForMs}`;
}

/** Acquire the deployed advisory lock for one scheduled automation. */
export function withScheduledAutomationLock<T>(
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

function requireStoredTask(task: ScheduledAutomation): ScheduledAutomation {
  const parsed = scheduledAutomationSchema.safeParse(task);
  if (!parsed.success) {
    throw new Error("Scheduled automation routing context is invalid.");
  }
  const { title, ...current } = parsed.data;
  const normalizedTitle = title?.trim() || undefined;
  return {
    ...current,
    ...(normalizedTitle ? { title: normalizedTitle } : undefined),
  };
}

function scheduledAutomationJsonRecord(
  task: ScheduledAutomation,
): ScheduledAutomationRecord {
  const { title: _title, ...record } = task;
  return record;
}

async function upsertScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
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
      record: scheduledAutomationJsonRecord(task),
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

/** Read and decode one scheduled automation. */
export async function readScheduledAutomation(
  db: JuniorDatabase,
  taskId: string,
): Promise<ScheduledAutomation | undefined> {
  const rows = await db
    .select({
      creatorIdentityId: juniorSchedulerTasks.creatorIdentityId,
      record: juniorSchedulerTasks.record,
      title: juniorSchedulerTasks.title,
    })
    .from(juniorSchedulerTasks)
    .where(eq(juniorSchedulerTasks.id, taskId))
    .limit(1);
  return rows[0] ? parseScheduledAutomationRow(rows[0]) : undefined;
}

async function readListedScheduledAutomations(
  db: JuniorDatabase,
  teamId?: string,
): Promise<ScheduledAutomation[]> {
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
  return rows
    .map(parseScheduledAutomationRow)
    .filter(isListedScheduledAutomation);
}

/** List decoded scheduled automations in stable creation order. */
export async function listScheduledAutomations(
  db: JuniorDatabase,
): Promise<ScheduledAutomation[]> {
  return await readListedScheduledAutomations(db);
}

/** List decoded scheduled automations for one team in stable creation order. */
export async function listScheduledAutomationsForTeam(
  db: JuniorDatabase,
  teamId: string,
): Promise<ScheduledAutomation[]> {
  return await readListedScheduledAutomations(db, teamId);
}

async function writeScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
  current: ScheduledAutomation | undefined,
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
  // A deleted task must not start another occurrence. Skip pending claims now;
  // already-running dispatches finish and then stop because due times are cleared.
  if (task.status === "deleted" && current?.status !== "deleted") {
    await skipPendingRunsForDeletedTask(db, task);
  }
  await upsertScheduledAutomation(db, task);
}

async function skipPendingRunsForDeletedTask(
  db: JuniorDatabase,
  task: ScheduledAutomation,
): Promise<void> {
  const errorMessage = `Scheduled automation ${task.id} was deleted before the run started.`;
  const rows = await db
    .select({ record: juniorSchedulerRuns.record })
    .from(juniorSchedulerRuns)
    .where(
      and(
        eq(juniorSchedulerRuns.taskId, task.id),
        eq(juniorSchedulerRuns.status, "pending"),
      ),
    );
  for (const row of rows) {
    const parsed = scheduledRunSchema.safeParse(row.record);
    if (!parsed.success || parsed.data.status !== "pending") continue;
    const next = scheduledRunSchema.parse({
      ...parsed.data,
      completedAtMs: task.updatedAtMs,
      errorMessage,
      status: "skipped",
    });
    await db
      .update(juniorSchedulerRuns)
      .set({
        record: next,
        status: next.status,
      })
      .where(
        and(
          eq(juniorSchedulerRuns.id, next.id),
          eq(juniorSchedulerRuns.status, "pending"),
        ),
      );
  }
}

/** Create a scheduled automation once under its retry-stable task lock. */
export async function createScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
): Promise<ScheduledAutomation> {
  const next = requireStoredTask(task);
  return await withScheduledAutomationLock(db, task.id, async (tx) => {
    const current = await readScheduledAutomation(tx, task.id);
    if (current) return current;
    await writeScheduledAutomation(tx, next, undefined);
    return next;
  });
}

/** Save a scheduled automation and clear its blocked occurrence on reactivation. */
export async function saveScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
): Promise<ScheduledAutomation> {
  const next = requireStoredTask(task);
  await withScheduledAutomationLock(db, task.id, async (tx) => {
    const current = await readScheduledAutomation(tx, task.id);
    await writeScheduledAutomation(tx, next, current);
  });
  return next;
}

/** Save a scheduled automation inside a task lock already held by the caller. */
export async function saveScheduledAutomationInLock(
  db: JuniorDatabase,
  task: ScheduledAutomation,
  current: ScheduledAutomation | undefined,
): Promise<void> {
  await writeScheduledAutomation(db, requireStoredTask(task), current);
}

/** List scheduled automations whose current Slack destination is public. */
export async function listPublicScheduledAutomationsForTeams(
  db: JuniorDatabase,
  teamIds: string[],
  input: { limit: number; query?: string },
): Promise<ScheduledAutomation[]> {
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
        input.query
          ? sql<boolean>`strpos(lower(coalesce(${juniorSchedulerTasks.title}, ${juniorSchedulerTasks.record}->'task'->>'text')), ${input.query}) > 0`
          : undefined,
        eq(juniorDestinations.visibility, "public"),
      ),
    )
    .orderBy(
      desc(juniorSchedulerTasks.createdAtMs),
      desc(juniorSchedulerTasks.id),
    )
    .limit(input.limit);
  return rows
    .map(parseScheduledAutomationRow)
    .filter(isListedScheduledAutomation);
}
