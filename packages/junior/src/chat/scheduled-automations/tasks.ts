import { requireAutomationRevision } from "@/chat/automations/revision";
import { recordAutomationVersion } from "@/chat/automations/versions";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomations } from "@/db/schema/automations";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { scheduledAutomationSchema, type ScheduledAutomation } from "./types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";

type AutomationRow = typeof juniorAutomations.$inferSelect;

/** Decode a Scheduled automation row. Returns undefined for an invalid row. */
export function parseScheduledAutomationRow(
  row: AutomationRow,
): ScheduledAutomation | undefined {
  const columns = {
    createdAtMs: row.createdAtMs,
    creatorIdentityId: row.creatorIdentityId,
    id: row.id,
    nextRunAtMs: row.nextRunAtMs,
    runNowAtMs: row.runNowAtMs,
    status: row.status,
    statusReason: row.statusReason,
    title: row.title,
  };
  // A null column means the field is absent, not present as undefined.
  const parsed = scheduledAutomationSchema.safeParse({
    ...row.record,
    ...Object.fromEntries(
      Object.entries(columns).filter(([, value]) => value !== null),
    ),
  });
  return parsed.success ? parsed.data : undefined;
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

async function upsertScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
): Promise<void> {
  const {
    createdAtMs,
    creatorIdentityId,
    id,
    nextRunAtMs,
    runNowAtMs,
    status,
    statusReason,
    title,
    ...record
  } = task;
  const columns = {
    channelId: record.destination.channelId,
    createdAtMs,
    creatorIdentityId,
    creatorSlackUserId: record.createdBy.slackUserId,
    instruction: record.task.text,
    nextRunAtMs: nextRunAtMs ?? null,
    record,
    runNowAtMs: runNowAtMs ?? null,
    status,
    statusReason: statusReason ?? null,
    teamId: record.destination.teamId,
    title: title?.trim() || null,
  };
  await db
    .insert(juniorAutomations)
    .values({ ...columns, id, kind: "scheduled" })
    .onConflictDoUpdate({ target: juniorAutomations.id, set: columns });
}

/** Read and decode one scheduled automation. */
export async function readScheduledAutomation(
  db: JuniorDatabase,
  taskId: string,
): Promise<ScheduledAutomation | undefined> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.id, taskId),
        eq(juniorAutomations.kind, "scheduled"),
      ),
    )
    .limit(1);
  return rows[0] ? parseScheduledAutomationRow(rows[0]) : undefined;
}

async function readListedScheduledAutomations(
  db: JuniorDatabase,
  teamId?: string,
): Promise<ScheduledAutomation[]> {
  const rows = await db
    .select()
    .from(juniorAutomations)
    .where(
      and(
        eq(juniorAutomations.kind, "scheduled"),
        ne(juniorAutomations.status, "deleted"),
        teamId === undefined ? undefined : eq(juniorAutomations.teamId, teamId),
      ),
    )
    .orderBy(asc(juniorAutomations.createdAtMs), asc(juniorAutomations.id));
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
  editedBy?: ScheduledAutomation["createdBy"],
): Promise<void> {
  // Reactivation forgets the blocked slot so the same occurrence can dispatch.
  if (
    current?.status === "blocked" &&
    task.status === "active" &&
    typeof task.nextRunAtMs === "number" &&
    Number.isFinite(task.nextRunAtMs)
  ) {
    await db
      .delete(juniorAutomationRuns)
      .where(
        and(
          eq(
            juniorAutomationRuns.id,
            scheduledRunId(task.id, task.nextRunAtMs),
          ),
          eq(juniorAutomationRuns.status, "blocked"),
        ),
      );
  }
  // A deleted task must not start another occurrence. Skip pending claims now;
  // already-running dispatches finish and then stop because due times are cleared.
  if (task.status === "deleted" && current?.status !== "deleted") {
    await skipPendingRunsForDeletedTask(db, task);
  }
  await upsertScheduledAutomation(db, task);
  await recordAutomationVersion(db, task, current, editedBy);
}

async function skipPendingRunsForDeletedTask(
  db: JuniorDatabase,
  task: ScheduledAutomation,
): Promise<void> {
  await db
    .update(juniorAutomationRuns)
    .set({
      completedAtMs: task.updatedAtMs,
      errorMessage: `Scheduled automation ${task.id} was deleted before the run started.`,
      status: "skipped",
    })
    .where(
      and(
        eq(juniorAutomationRuns.automationId, task.id),
        eq(juniorAutomationRuns.status, "pending"),
      ),
    );
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

/**
 * Save a scheduled automation and clear its blocked occurrence on reactivation.
 * Pass `editedBy` when a person changes the definition so its version names them.
 */
export async function saveScheduledAutomation(
  db: JuniorDatabase,
  task: ScheduledAutomation,
  expectedRevision?: string,
  editedBy?: ScheduledAutomation["createdBy"],
): Promise<ScheduledAutomation> {
  const next = requireStoredTask(task);
  await withScheduledAutomationLock(db, task.id, async (tx) => {
    const current = await readScheduledAutomation(tx, task.id);
    if (expectedRevision !== undefined)
      requireAutomationRevision(current, expectedRevision);
    await writeScheduledAutomation(tx, next, current, editedBy);
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
