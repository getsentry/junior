import {
  pluginCredentialSubjectSchema,
  destinationSchema,
  isSlackDestination,
  slackActorSchema,
  type PluginReadState,
  type PluginState,
} from "@sentry/junior-plugin-api";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";
import { z } from "zod";
import { getNextRunAtMs } from "./cadence";
import * as schedulerSqlSchema from "./db/schema";
import { juniorSchedulerRuns, juniorSchedulerTasks } from "./db/schema";
import {
  scheduledTaskCredentialModeSchema,
  type ScheduledRun,
  type ScheduledTask,
} from "./types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";
const SCHEDULER_RECORD_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const SCHEDULED_RUN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 6 * 60 * 60 * 1000;
const PENDING_CLAIM_STALE_MS = 60_000;
const MISSED_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10_000;
const SQL_INCOMPLETE_RUN_STATUSES = ["pending", "running"] as const;
export type SchedulerDb = PgDatabase<
  PgQueryResultHKT,
  typeof schedulerSqlSchema
>;
const slackDestinationSchema = destinationSchema.refine(isSlackDestination);
const taskPrincipalSchema = z
  .object({
    slackUserId: slackActorSchema.shape.userId,
    fullName: z.string().optional(),
    userName: z.string().optional(),
  })
  .strict();
const recurrenceSchema = z
  .object({
    dayOfMonth: z.number().optional(),
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number(),
    month: z.number().optional(),
    startDate: z.string(),
    time: z
      .object({
        hour: z.number(),
        minute: z.number(),
      })
      .strict(),
    weekdays: z.array(z.number()).optional(),
  })
  .strict();
const taskScheduleSchema = z
  .object({
    description: z.string(),
    kind: z.enum(["one_off", "recurring"]),
    recurrence: recurrenceSchema.optional(),
    timezone: z.string(),
  })
  .strict();
const taskSpecSchema = z
  .object({
    text: z.string(),
  })
  .strict();
const taskRecordFields = {
  id: z.string(),
  conversationAccess: z
    .object({
      audience: z.enum(["direct", "group", "channel"]),
      visibility: z.enum(["private", "public", "unknown"]),
    })
    .strict()
    .optional(),
  createdAtMs: z.number(),
  createdBy: taskPrincipalSchema,
  destination: slackDestinationSchema,
  executionActor: z
    .object({
      platform: z.literal("system"),
      name: z.string(),
    })
    .strict()
    .optional(),
  lastRunAtMs: z.number().optional(),
  nextRunAtMs: z.number().optional(),
  originalRequest: z.string().optional(),
  runNowAtMs: z.number().optional(),
  schedule: taskScheduleSchema,
  status: z.enum(["active", "paused", "blocked", "deleted"]),
  statusReason: z.string().optional(),
  task: taskSpecSchema,
  updatedAtMs: z.number(),
  version: z.number().optional(),
};
const taskRecordSchema = z
  .object({
    ...taskRecordFields,
    credentialMode: scheduledTaskCredentialModeSchema,
  })
  .strict();
// TODO(v0.101.0): Remove parsing for scheduler task records without credentialMode.
const legacyTaskRecordSchema = z
  .object({
    ...taskRecordFields,
    credentialSubject: pluginCredentialSubjectSchema.optional(),
  })
  .strict();
const runRecordSchema = z
  .object({
    id: z.string(),
    attempt: z.number(),
    claimedAtMs: z.number(),
    completedAtMs: z.number().optional(),
    dispatchId: z.string().optional(),
    errorMessage: z.string().optional(),
    idempotencyKey: z.string().optional(),
    resultMessageTs: z.string().optional(),
    scheduledForMs: z.number(),
    startedAtMs: z.number().optional(),
    status: z.enum([
      "pending",
      "running",
      "completed",
      "failed",
      "blocked",
      "skipped",
    ]),
    taskId: z.string(),
    taskVersion: z.number().optional(),
  })
  .strict();

export interface SchedulerStore {
  claimDueRun(args: { nowMs: number }): Promise<ScheduledRun | undefined>;
  getRun(runId: string): Promise<ScheduledRun | undefined>;
  getTask(taskId: string): Promise<ScheduledTask | undefined>;
  listIncompleteRuns(): Promise<ScheduledRun[]>;
  listTasks(): Promise<ScheduledTask[]>;
  listTasksForTeam(teamId: string): Promise<ScheduledTask[]>;
  markRunBlocked(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
    startedAtMs?: number;
  }): Promise<ScheduledRun | undefined>;
  markRunCompleted(args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
    startedAtMs: number;
  }): Promise<ScheduledRun | undefined>;
  markRunFailed(args: {
    completedAtMs: number;
    errorMessage: string;
    startedAtMs?: number;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  markRunSkipped(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  markRunDispatched(args: {
    claimedAtMs: number;
    dispatchId: string;
    nowMs: number;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  saveTask(task: ScheduledTask): Promise<void>;
  updateTaskAfterRun(args: {
    errorMessage?: string;
    nowMs: number;
    run: ScheduledRun;
    status: "blocked" | "completed" | "failed";
  }): Promise<void>;
}

export interface SchedulerOperationalStore {
  listIncompleteRunsForTasks(tasks: ScheduledTask[]): Promise<ScheduledRun[]>;
  listTasks(): Promise<ScheduledTask[]>;
}

function taskKey(taskId: string): string {
  return `${SCHEDULER_KEY_PREFIX}:task:${taskId}`;
}

function taskLockKey(taskId: string): string {
  return `${taskKey(taskId)}:lock`;
}

function runKey(runId: string): string {
  return `${SCHEDULER_KEY_PREFIX}:run:${runId}`;
}

function claimKey(taskId: string, scheduledForMs: number): string {
  return `${SCHEDULER_KEY_PREFIX}:claim:${taskId}:${scheduledForMs}`;
}

function activeRunKey(taskId: string): string {
  return `${SCHEDULER_KEY_PREFIX}:active:${taskId}`;
}

function globalTaskIndexKey(): string {
  return `${SCHEDULER_KEY_PREFIX}:tasks`;
}

function teamTaskIndexKey(teamId: string): string {
  return `${SCHEDULER_KEY_PREFIX}:team:${teamId}:tasks`;
}

function indexLockKey(indexKey: string): string {
  return `${indexKey}:lock`;
}

function buildRunId(taskId: string, scheduledForMs: number): string {
  return `${taskId}:${scheduledForMs}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function withLock<T>(
  state: PluginState,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await state.withLock(key, LOCK_TTL_MS, callback);
}

async function addToIndex(
  state: PluginState,
  key: string,
  taskId: string,
): Promise<void> {
  await withLock(state, indexLockKey(key), async () => {
    const current = ((await state.get<string[]>(key)) ?? []).filter(
      (value): value is string => typeof value === "string",
    );
    await state.set(key, unique([...current, taskId]), SCHEDULER_RECORD_TTL_MS);
  });
}

async function removeFromIndex(
  state: PluginState,
  key: string,
  taskId: string,
): Promise<void> {
  await withLock(state, indexLockKey(key), async () => {
    const current = unique(
      ((await state.get<string[]>(key)) ?? []).filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const next = current.filter((value) => value !== taskId);
    if (next.length === current.length) {
      return;
    }
    if (next.length === 0) {
      await state.delete(key);
      return;
    }
    await state.set(key, next, SCHEDULER_RECORD_TTL_MS);
  });
}

async function getIndex(
  state: PluginReadState,
  key: string,
): Promise<string[]> {
  const values = (await state.get<string[]>(key)) ?? [];
  return unique(
    values.filter((value): value is string => typeof value === "string"),
  );
}

async function clearActiveRun(
  state: PluginState,
  taskId: string,
  runId: string,
): Promise<void> {
  await withLock(state, indexLockKey(activeRunKey(taskId)), async () => {
    const current = await state.get<{ runId?: unknown }>(activeRunKey(taskId));
    if (current?.runId === runId) {
      await state.delete(activeRunKey(taskId));
    }
  });
}

async function clearStaleActiveRun(
  state: PluginState,
  taskId: string,
  nowMs: number,
): Promise<boolean> {
  const active = await state.get<{
    claimedAtMs?: unknown;
    runId?: unknown;
    scheduledForMs?: unknown;
  }>(activeRunKey(taskId));
  if (typeof active?.runId !== "string") {
    await state.delete(activeRunKey(taskId));
    return true;
  }

  const activeRun = parseStoredRun(await state.get(runKey(active.runId)));
  if (!isStaleActiveRun(active, activeRun, nowMs)) {
    return false;
  }

  await clearActiveRun(state, taskId, active.runId);
  if (typeof active.scheduledForMs === "number") {
    await state.delete(claimKey(taskId, active.scheduledForMs));
  }
  return true;
}

function isFinishedRun(run: ScheduledRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "blocked" ||
    run.status === "skipped"
  );
}

function isStaleActiveRun(
  active: { claimedAtMs?: unknown },
  run: ScheduledRun | undefined,
  nowMs: number,
): boolean {
  if (run) {
    return isFinishedRun(run) || isStalePendingRun(run, nowMs);
  }

  return (
    typeof active.claimedAtMs === "number" &&
    active.claimedAtMs + PENDING_CLAIM_STALE_MS <= nowMs
  );
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

function isDueTask(
  task: ScheduledTask,
  nowMs: number,
): task is ScheduledTask & {
  nextRunAtMs?: number;
  runNowAtMs?: number;
} {
  return (
    task.status === "active" &&
    ((typeof task.runNowAtMs === "number" &&
      Number.isFinite(task.runNowAtMs) &&
      task.runNowAtMs <= nowMs) ||
      (typeof task.nextRunAtMs === "number" &&
        Number.isFinite(task.nextRunAtMs) &&
        task.nextRunAtMs <= nowMs))
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

function buildScheduledRun(args: {
  claimedAtMs: number;
  scheduledForMs: number;
  task: ScheduledTask;
}): ScheduledRun {
  return {
    id: buildRunId(args.task.id, args.scheduledForMs),
    attempt: 1,
    claimedAtMs: args.claimedAtMs,
    scheduledForMs: args.scheduledForMs,
    status: "pending",
    taskId: args.task.id,
  };
}

function buildSkippedScheduledRun(args: {
  completedAtMs: number;
  errorMessage: string;
  scheduledForMs: number;
  task: ScheduledTask;
}): ScheduledRun {
  return {
    ...buildScheduledRun({
      claimedAtMs: args.completedAtMs,
      scheduledForMs: args.scheduledForMs,
      task: args.task,
    }),
    completedAtMs: args.completedAtMs,
    errorMessage: args.errorMessage,
    status: "skipped",
  };
}

function isMissedRunTooOld(args: {
  nowMs: number;
  scheduledForMs: number;
}): boolean {
  return args.scheduledForMs + MISSED_RUN_MAX_AGE_MS < args.nowMs;
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

function isEarlierTask(left: ScheduledTask, right: ScheduledTask): boolean {
  return (
    left.createdAtMs < right.createdAtMs ||
    (left.createdAtMs === right.createdAtMs && left.id < right.id)
  );
}

function canFinishRun(
  run: ScheduledRun,
  startedAtMs: number | undefined,
): boolean {
  if (run.status === "pending") {
    return startedAtMs === undefined;
  }
  return run.status === "running" && run.startedAtMs === startedAtMs;
}

/** Decode retained scheduler task state, skipping invalid legacy records. */
function parseStoredTask(value: unknown): ScheduledTask | undefined {
  const parsed = taskRecordSchema.safeParse(parseJsonRecord(value));
  return parsed.success ? stripLegacyTaskFields(parsed.data) : undefined;
}

/** Decode pre-credential-mode tasks only for the state-to-SQL migration. */
function parseLegacyStoredTaskForMigration(
  value: unknown,
): ScheduledTask | undefined {
  const parsed = legacyTaskRecordSchema.safeParse(parseJsonRecord(value));
  if (!parsed.success) {
    return undefined;
  }
  const {
    credentialSubject: _credentialSubject,
    version: _version,
    ...task
  } = parsed.data;
  return {
    ...task,
    credentialMode: "system",
  };
}

/** Decode retained scheduler run state, skipping invalid legacy records. */
function parseStoredRun(value: unknown): ScheduledRun | undefined {
  const parsed = runRecordSchema.safeParse(parseJsonRecord(value));
  return parsed.success ? stripLegacyRunFields(parsed.data) : undefined;
}

function stripLegacyTaskFields(
  task: ScheduledTask & { version?: number },
): ScheduledTask {
  const { version: _version, ...current } = task;
  return current;
}

function stripLegacyRunFields(
  run: ScheduledRun & {
    idempotencyKey?: string;
    taskVersion?: number;
  },
): ScheduledRun {
  const {
    idempotencyKey: _idempotencyKey,
    taskVersion: _taskVersion,
    ...current
  } = run;
  return current;
}

function parseJsonRecord<T>(value: unknown): T | undefined {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object") {
    return value as T;
  }
  return undefined;
}

function present<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function requireStoredTask(task: ScheduledTask): ScheduledTask {
  const parsed = parseStoredTask(task);
  if (!parsed) {
    throw new Error("Scheduled task routing context is invalid.");
  }
  return parsed;
}

async function getTaskFromState(
  state: PluginReadState,
  taskId: string,
): Promise<ScheduledTask | undefined> {
  return parseStoredTask(await state.get(taskKey(taskId)));
}

async function listTasksFromState(
  state: PluginReadState,
  indexKey: string,
): Promise<ScheduledTask[]> {
  const ids = await getIndex(state, indexKey);
  const tasks = await Promise.all(ids.map((id) => getTaskFromState(state, id)));
  return tasks
    .filter((task): task is ScheduledTask => Boolean(task))
    .filter((task) => task.status !== "deleted")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

async function getRunFromState(
  state: PluginReadState,
  runId: string,
): Promise<ScheduledRun | undefined> {
  return parseStoredRun(await state.get(runKey(runId)));
}

async function listIncompleteRunsForTasksFromState(
  state: PluginReadState,
  tasks: ScheduledTask[],
): Promise<ScheduledRun[]> {
  const runs: ScheduledRun[] = [];
  for (const task of tasks) {
    const active = await state.get<{ runId?: unknown }>(activeRunKey(task.id));
    if (typeof active?.runId !== "string") {
      continue;
    }
    const run = await getRunFromState(state, active.runId);
    if (run && !isFinishedRun(run)) {
      runs.push(run);
    }
  }
  return runs;
}

class PluginStateSchedulerOperationalStore implements SchedulerOperationalStore {
  private readonly state: PluginReadState;

  constructor(state: PluginReadState) {
    this.state = state;
  }

  async listTasks(): Promise<ScheduledTask[]> {
    return await listTasksFromState(this.state, globalTaskIndexKey());
  }

  async listIncompleteRunsForTasks(
    tasks: ScheduledTask[],
  ): Promise<ScheduledRun[]> {
    return await listIncompleteRunsForTasksFromState(this.state, tasks);
  }
}

class PluginStateSchedulerStore implements SchedulerStore {
  private readonly state: PluginState;

  constructor(state: PluginState) {
    this.state = state;
  }

  async saveTask(task: ScheduledTask): Promise<void> {
    const next = requireStoredTask(task);
    await withLock(this.state, taskLockKey(task.id), async () => {
      const current = await getTaskFromState(this.state, task.id);
      await this.saveTaskRecord(next, current);
    });
  }

  private async saveTaskRecord(
    task: ScheduledTask,
    current: ScheduledTask | undefined,
  ): Promise<void> {
    if (
      current?.status === "blocked" &&
      task.status === "active" &&
      typeof task.nextRunAtMs === "number" &&
      Number.isFinite(task.nextRunAtMs)
    ) {
      await this.state.delete(claimKey(task.id, task.nextRunAtMs));
    }
    await this.state.set(taskKey(task.id), task, SCHEDULER_RECORD_TTL_MS);

    if (task.status === "deleted") {
      await removeFromIndex(this.state, globalTaskIndexKey(), task.id);
      await removeFromIndex(
        this.state,
        teamTaskIndexKey(task.destination.teamId),
        task.id,
      );
      if (current && current.destination.teamId !== task.destination.teamId) {
        await removeFromIndex(
          this.state,
          teamTaskIndexKey(current.destination.teamId),
          task.id,
        );
      }
      return;
    }

    await addToIndex(this.state, globalTaskIndexKey(), task.id);
    await addToIndex(
      this.state,
      teamTaskIndexKey(task.destination.teamId),
      task.id,
    );
    if (current && current.destination.teamId !== task.destination.teamId) {
      await removeFromIndex(
        this.state,
        teamTaskIndexKey(current.destination.teamId),
        task.id,
      );
    }
  }

  async getTask(taskId: string): Promise<ScheduledTask | undefined> {
    return await getTaskFromState(this.state, taskId);
  }

  async listTasks(): Promise<ScheduledTask[]> {
    return await listTasksFromState(this.state, globalTaskIndexKey());
  }

  async listTasksForTeam(teamId: string): Promise<ScheduledTask[]> {
    return await listTasksFromState(this.state, teamTaskIndexKey(teamId));
  }

  async claimDueRun(args: {
    nowMs: number;
  }): Promise<ScheduledRun | undefined> {
    const ids = await getIndex(this.state, globalTaskIndexKey());

    for (const id of ids) {
      const task = await this.getTask(id);
      if (!task || !isDueTask(task, args.nowMs)) {
        continue;
      }

      const scheduledForMs = getDueRunAtMs(task, args.nowMs);
      if (scheduledForMs === undefined) {
        continue;
      }
      const runId = buildRunId(task.id, scheduledForMs);
      const tryClaimActiveRun = async (): Promise<boolean> =>
        await this.state.setIfNotExists(
          activeRunKey(task.id),
          { claimedAtMs: args.nowMs, runId, scheduledForMs },
          CLAIM_TTL_MS,
        );

      let activeClaimed = await tryClaimActiveRun();
      if (!activeClaimed) {
        if (await clearStaleActiveRun(this.state, task.id, args.nowMs)) {
          activeClaimed = await tryClaimActiveRun();
        }
        if (!activeClaimed) {
          continue;
        }
      }

      if (isMissedRunTooOld({ nowMs: args.nowMs, scheduledForMs })) {
        await this.skipMissedRun({ nowMs: args.nowMs, scheduledForMs, task });
        await clearActiveRun(this.state, task.id, runId);
        continue;
      }

      const tryClaimScheduledSlot = async (): Promise<boolean> =>
        await this.state.setIfNotExists(
          claimKey(task.id, scheduledForMs),
          { claimedAtMs: args.nowMs },
          CLAIM_TTL_MS,
        );

      let claimed = await tryClaimScheduledSlot();
      if (!claimed) {
        const existingRun = await this.getRun(runId);
        if (isStalePendingRun(existingRun, args.nowMs)) {
          await clearActiveRun(this.state, task.id, runId);
          await this.state.delete(claimKey(task.id, scheduledForMs));
          activeClaimed = await tryClaimActiveRun();
          claimed = activeClaimed ? await tryClaimScheduledSlot() : false;
        }
        if (!claimed) {
          await clearActiveRun(this.state, task.id, runId);
          continue;
        }
      }

      const run = buildScheduledRun({
        claimedAtMs: args.nowMs,
        scheduledForMs,
        task,
      });
      await this.state.set(runKey(run.id), run, SCHEDULED_RUN_TTL_MS);
      return run;
    }

    return undefined;
  }

  private async skipMissedRun(args: {
    nowMs: number;
    scheduledForMs: number;
    task: ScheduledTask;
  }): Promise<void> {
    await withLock(this.state, taskLockKey(args.task.id), async () => {
      const current =
        (await getTaskFromState(this.state, args.task.id)) ?? undefined;
      if (
        !current ||
        current.status !== "active" ||
        getDueRunAtMs(current, args.nowMs) !== args.scheduledForMs
      ) {
        return;
      }

      const duplicateOf = await this.findStaleRecoveryCanonicalTask(current);
      const errorMessage = duplicateOf
        ? `Duplicate stale scheduled task was skipped without dispatch. Canonical task: ${duplicateOf.id}.`
        : "Scheduled occurrence was more than 24 hours late and was skipped without dispatch.";
      await this.state.set(
        runKey(buildRunId(current.id, args.scheduledForMs)),
        buildSkippedScheduledRun({
          completedAtMs: args.nowMs,
          errorMessage,
          scheduledForMs: args.scheduledForMs,
          task: current,
        }),
        SCHEDULED_RUN_TTL_MS,
      );

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
      const nextStatus = nextRunAtMs ? "active" : "paused";

      await this.saveTaskRecord(
        {
          ...current,
          nextRunAtMs,
          runNowAtMs: isRunNow ? undefined : current.runNowAtMs,
          status: nextStatus,
          statusReason: nextStatus === "paused" ? errorMessage : undefined,
          updatedAtMs: args.nowMs,
        },
        current,
      );
    });
  }

  private async findStaleRecoveryCanonicalTask(
    task: ScheduledTask,
  ): Promise<ScheduledTask | undefined> {
    const fingerprint = taskDedupeFingerprint(task);
    const ids = await getIndex(
      this.state,
      teamTaskIndexKey(task.destination.teamId),
    );
    const tasks = await Promise.all(
      ids.filter((id) => id !== task.id).map((id) => this.getTask(id)),
    );
    return tasks
      .filter((candidate): candidate is ScheduledTask => Boolean(candidate))
      .filter(
        (candidate) =>
          candidate.status === "active" &&
          isEarlierTask(candidate, task) &&
          taskDedupeFingerprint(candidate) === fingerprint,
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
      .at(0);
  }

  async getRun(runId: string): Promise<ScheduledRun | undefined> {
    return await getRunFromState(this.state, runId);
  }

  async listIncompleteRuns(): Promise<ScheduledRun[]> {
    const tasks = await this.listTasks();
    return await listIncompleteRunsForTasksFromState(this.state, tasks);
  }

  async markRunDispatched(args: {
    claimedAtMs: number;
    dispatchId: string;
    nowMs: number;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) =>
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

  async markRunCompleted(args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
    startedAtMs: number;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) =>
      canFinishRun(run, args.startedAtMs)
        ? {
            ...run,
            completedAtMs: args.completedAtMs,
            resultMessageTs: args.resultMessageTs,
            status: "completed",
          }
        : undefined,
    );
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async markRunFailed(args: {
    completedAtMs: number;
    errorMessage: string;
    startedAtMs?: number;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) =>
      canFinishRun(run, args.startedAtMs)
        ? {
            ...run,
            completedAtMs: args.completedAtMs,
            errorMessage: args.errorMessage,
            status: "failed",
          }
        : undefined,
    );
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async markRunSkipped(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) =>
      run.status === "pending"
        ? {
            ...run,
            completedAtMs: args.completedAtMs,
            errorMessage: args.errorMessage,
            status: "skipped",
          }
        : undefined,
    );
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async markRunBlocked(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
    startedAtMs?: number;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) =>
      canFinishRun(run, args.startedAtMs)
        ? {
            ...run,
            completedAtMs: args.completedAtMs,
            errorMessage: args.errorMessage,
            status: "blocked",
          }
        : undefined,
    );
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async updateTaskAfterRun(args: {
    errorMessage?: string;
    nowMs: number;
    run: ScheduledRun;
    status: "blocked" | "completed" | "failed";
  }): Promise<void> {
    await withLock(this.state, taskLockKey(args.run.taskId), async () => {
      const current =
        (await getTaskFromState(this.state, args.run.taskId)) ?? undefined;
      if (!current || current.status === "deleted") {
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
          nextRunAtMs = getNextRunAtMs(
            current,
            current.nextRunAtMs,
            args.nowMs,
          );
        }
        await this.saveTaskRecord(
          {
            ...current,
            lastRunAtMs: args.run.scheduledForMs,
            nextRunAtMs,
            runNowAtMs: undefined,
            status:
              args.status === "blocked"
                ? "blocked"
                : nextRunAtMs
                  ? current.status
                  : "paused",
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
        await this.saveTaskRecord(
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

      await this.saveTaskRecord(
        {
          ...current,
          lastRunAtMs: args.run.scheduledForMs,
          nextRunAtMs,
          status:
            args.status === "blocked"
              ? "blocked"
              : nextRunAtMs
                ? "active"
                : "paused",
          statusReason:
            args.status === "blocked" ? args.errorMessage : undefined,
          updatedAtMs: args.nowMs,
        },
        current,
      );
    });
  }

  private async updateRun(
    runId: string,
    update: (run: ScheduledRun) => ScheduledRun | undefined,
  ): Promise<ScheduledRun | undefined> {
    return await withLock(this.state, indexLockKey(runKey(runId)), async () => {
      const current = await this.getRun(runId);
      if (!current) {
        return undefined;
      }
      const next = update(current);
      if (!next) {
        return undefined;
      }
      await this.state.set(runKey(runId), next, SCHEDULED_RUN_TTL_MS);
      return next;
    });
  }
}

/** Create a scheduler store backed by this plugin's durable state namespace. */
export function createSchedulerStore(state: PluginState): SchedulerStore {
  return new PluginStateSchedulerStore(state);
}

/** Create a read-only scheduler store for operational reporting. */
export function createSchedulerOperationalStore(
  state: PluginReadState,
): SchedulerOperationalStore {
  return new PluginStateSchedulerOperationalStore(state);
}

type SchedulerTaskRow = {
  record: unknown;
};

type SchedulerRunRow = {
  record: unknown;
};

/** Decode scheduler SQL task records and reject rows unsafe for scan paths. */
function parseSqlTaskRecord(value: unknown): ScheduledTask | undefined {
  const parsed = taskRecordSchema.safeParse(parseJsonRecord(value));
  return parsed.success ? stripLegacyTaskFields(parsed.data) : undefined;
}

function parseSqlTaskRow(row: SchedulerTaskRow): ScheduledTask | undefined {
  return parseSqlTaskRecord(row.record);
}

/** Decode scheduler SQL run records and reject rows unsafe for scan paths. */
function parseSqlRunRow(row: SchedulerRunRow): ScheduledRun | undefined {
  const parsed = runRecordSchema.safeParse(parseJsonRecord(row.record));
  return parsed.success ? stripLegacyRunFields(parsed.data) : undefined;
}

async function withSqlLock<T>(
  db: SchedulerDb,
  key: string,
  callback: (db: SchedulerDb) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    return await callback(tx);
  });
}

async function upsertSqlTask(
  db: SchedulerDb,
  task: ScheduledTask,
): Promise<void> {
  await db
    .insert(juniorSchedulerTasks)
    .values({
      createdAtMs: task.createdAtMs,
      id: task.id,
      nextRunAtMs: task.nextRunAtMs,
      record: task,
      runNowAtMs: task.runNowAtMs,
      status: task.status,
      teamId: task.destination.teamId,
    })
    .onConflictDoUpdate({
      target: juniorSchedulerTasks.id,
      set: {
        createdAtMs: sql`excluded.created_at_ms`,
        nextRunAtMs: sql`excluded.next_run_at_ms`,
        record: sql`excluded.record`,
        runNowAtMs: sql`excluded.run_now_at_ms`,
        status: sql`excluded.status`,
        teamId: sql`excluded.team_id`,
      },
    });
}

async function upsertSqlRun(db: SchedulerDb, run: ScheduledRun): Promise<void> {
  await db
    .insert(juniorSchedulerRuns)
    .values({
      id: run.id,
      record: run,
      scheduledForMs: run.scheduledForMs,
      status: run.status,
      taskId: run.taskId,
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

async function getTaskFromSql(
  db: SchedulerDb,
  taskId: string,
): Promise<ScheduledTask | undefined> {
  const rows = await db
    .select({ record: juniorSchedulerTasks.record })
    .from(juniorSchedulerTasks)
    .where(eq(juniorSchedulerTasks.id, taskId))
    .limit(1);
  return rows[0] ? parseSqlTaskRow(rows[0]) : undefined;
}

async function getRunFromSql(
  db: SchedulerDb,
  runId: string,
): Promise<ScheduledRun | undefined> {
  const rows = await db
    .select({ record: juniorSchedulerRuns.record })
    .from(juniorSchedulerRuns)
    .where(eq(juniorSchedulerRuns.id, runId))
    .limit(1);
  return rows[0] ? parseSqlRunRow(rows[0]) : undefined;
}

async function listTasksFromSql(db: SchedulerDb): Promise<ScheduledTask[]> {
  const rows = await db
    .select({ record: juniorSchedulerTasks.record })
    .from(juniorSchedulerTasks)
    .where(ne(juniorSchedulerTasks.status, "deleted"))
    .orderBy(
      asc(juniorSchedulerTasks.createdAtMs),
      asc(juniorSchedulerTasks.id),
    );
  return rows.map(parseSqlTaskRow).filter(present);
}

async function listTasksForTeamFromSql(
  db: SchedulerDb,
  teamId: string,
): Promise<ScheduledTask[]> {
  const rows = await db
    .select({ record: juniorSchedulerTasks.record })
    .from(juniorSchedulerTasks)
    .where(
      and(
        eq(juniorSchedulerTasks.teamId, teamId),
        ne(juniorSchedulerTasks.status, "deleted"),
      ),
    )
    .orderBy(
      asc(juniorSchedulerTasks.createdAtMs),
      asc(juniorSchedulerTasks.id),
    );
  return rows.map(parseSqlTaskRow).filter(present);
}

async function listIncompleteRunsForTasksFromSql(
  db: SchedulerDb,
  tasks: ScheduledTask[],
): Promise<ScheduledRun[]> {
  if (tasks.length === 0) {
    return [];
  }
  const rows = await db
    .select({ record: juniorSchedulerRuns.record })
    .from(juniorSchedulerRuns)
    .where(
      and(
        inArray(
          juniorSchedulerRuns.taskId,
          tasks.map((task) => task.id),
        ),
        inArray(juniorSchedulerRuns.status, [...SQL_INCOMPLETE_RUN_STATUSES]),
      ),
    )
    .orderBy(
      asc(juniorSchedulerRuns.scheduledForMs),
      asc(juniorSchedulerRuns.id),
    );
  return rows.map(parseSqlRunRow).filter(present);
}

class SqlSchedulerStore implements SchedulerStore, SchedulerOperationalStore {
  constructor(private readonly db: SchedulerDb) {}

  async saveTask(task: ScheduledTask): Promise<void> {
    const next = requireStoredTask(task);
    await withSqlLock(this.db, taskLockKey(task.id), async (db) => {
      const current = await getTaskFromSql(db, task.id);
      await this.saveTaskRecord(db, next, current);
    });
  }

  private async saveTaskRecord(
    db: SchedulerDb,
    task: ScheduledTask,
    current: ScheduledTask | undefined,
  ): Promise<void> {
    // Reactivation intentionally forgets the blocked slot so authorization or
    // configuration fixes can dispatch the same scheduled occurrence again.
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
            eq(juniorSchedulerRuns.id, buildRunId(task.id, task.nextRunAtMs)),
            eq(juniorSchedulerRuns.status, "blocked"),
          ),
        );
    }
    await upsertSqlTask(db, task);
  }

  async getTask(taskId: string): Promise<ScheduledTask | undefined> {
    return await getTaskFromSql(this.db, taskId);
  }

  async listTasks(): Promise<ScheduledTask[]> {
    return await listTasksFromSql(this.db);
  }

  async listTasksForTeam(teamId: string): Promise<ScheduledTask[]> {
    return await listTasksForTeamFromSql(this.db, teamId);
  }

  async claimDueRun(args: {
    nowMs: number;
  }): Promise<ScheduledRun | undefined> {
    return await withSqlLock(this.db, "junior:scheduler:claim", async (db) => {
      const rows = await db
        .select({ record: juniorSchedulerTasks.record })
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
        const task = parseSqlTaskRow(row);
        if (!task) {
          continue;
        }
        const scheduledForMs = getDueRunAtMs(task, args.nowMs);
        if (scheduledForMs === undefined) {
          continue;
        }
        const runId = buildRunId(task.id, scheduledForMs);
        const incompleteRuns = await listIncompleteRunsForTasksFromSql(db, [
          task,
        ]);
        const incompleteRun = incompleteRuns.find((run) => run.id === runId);
        const blockingRun = incompleteRuns.find(
          (run) => run.id !== runId && !isStalePendingRun(run, args.nowMs),
        );
        if (blockingRun) {
          continue;
        }
        if (incompleteRun) {
          if (!isStalePendingRun(incompleteRun, args.nowMs)) {
            continue;
          }
          const reclaimed = {
            ...incompleteRun,
            attempt: incompleteRun.attempt + 1,
            claimedAtMs: args.nowMs,
          };
          await upsertSqlRun(db, reclaimed);
          return reclaimed;
        }
        const existingRun = await getRunFromSql(db, runId);
        if (existingRun) {
          continue;
        }

        if (isMissedRunTooOld({ nowMs: args.nowMs, scheduledForMs })) {
          await this.skipMissedRun(db, {
            nowMs: args.nowMs,
            scheduledForMs,
            task,
          });
          continue;
        }

        const run = buildScheduledRun({
          claimedAtMs: args.nowMs,
          scheduledForMs,
          task,
        });
        await upsertSqlRun(db, run);
        return run;
      }

      return undefined;
    });
  }

  private async skipMissedRun(
    db: SchedulerDb,
    args: {
      nowMs: number;
      scheduledForMs: number;
      task: ScheduledTask;
    },
  ): Promise<void> {
    const current = await getTaskFromSql(db, args.task.id);
    if (
      !current ||
      current.status !== "active" ||
      getDueRunAtMs(current, args.nowMs) !== args.scheduledForMs
    ) {
      return;
    }

    const duplicateOf = await this.findStaleRecoveryCanonicalTask(db, current);
    const errorMessage = duplicateOf
      ? `Duplicate stale scheduled task was skipped without dispatch. Canonical task: ${duplicateOf.id}.`
      : "Scheduled occurrence was more than 24 hours late and was skipped without dispatch.";
    await upsertSqlRun(
      db,
      buildSkippedScheduledRun({
        completedAtMs: args.nowMs,
        errorMessage,
        scheduledForMs: args.scheduledForMs,
        task: current,
      }),
    );

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
    const nextStatus = nextRunAtMs ? "active" : "paused";

    await this.saveTaskRecord(
      db,
      {
        ...current,
        nextRunAtMs,
        runNowAtMs: isRunNow ? undefined : current.runNowAtMs,
        status: nextStatus,
        statusReason: nextStatus === "paused" ? errorMessage : undefined,
        updatedAtMs: args.nowMs,
      },
      current,
    );
  }

  private async findStaleRecoveryCanonicalTask(
    db: SchedulerDb,
    task: ScheduledTask,
  ): Promise<ScheduledTask | undefined> {
    const fingerprint = taskDedupeFingerprint(task);
    const tasks = await listTasksForTeamFromSql(db, task.destination.teamId);
    return tasks
      .filter((candidate) => candidate.id !== task.id)
      .filter(
        (candidate) =>
          candidate.status === "active" &&
          isEarlierTask(candidate, task) &&
          taskDedupeFingerprint(candidate) === fingerprint,
      )
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id))
      .at(0);
  }

  async getRun(runId: string): Promise<ScheduledRun | undefined> {
    return await getRunFromSql(this.db, runId);
  }

  async listIncompleteRuns(): Promise<ScheduledRun[]> {
    return await listIncompleteRunsForTasksFromSql(
      this.db,
      await this.listTasks(),
    );
  }

  async listIncompleteRunsForTasks(
    tasks: ScheduledTask[],
  ): Promise<ScheduledRun[]> {
    return await listIncompleteRunsForTasksFromSql(this.db, tasks);
  }

  async markRunDispatched(args: {
    claimedAtMs: number;
    dispatchId: string;
    nowMs: number;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) =>
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

  async markRunCompleted(args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
    startedAtMs: number;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) =>
      canFinishRun(run, args.startedAtMs)
        ? {
            ...run,
            completedAtMs: args.completedAtMs,
            resultMessageTs: args.resultMessageTs,
            status: "completed",
          }
        : undefined,
    );
    return next;
  }

  async markRunFailed(args: {
    completedAtMs: number;
    errorMessage: string;
    startedAtMs?: number;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) =>
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

  async markRunSkipped(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) =>
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

  async markRunBlocked(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
    startedAtMs?: number;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) =>
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

  async updateTaskAfterRun(args: {
    errorMessage?: string;
    nowMs: number;
    run: ScheduledRun;
    status: "blocked" | "completed" | "failed";
  }): Promise<void> {
    await withSqlLock(this.db, taskLockKey(args.run.taskId), async (db) => {
      const current = await getTaskFromSql(db, args.run.taskId);
      if (!current || current.status === "deleted") {
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
          nextRunAtMs = getNextRunAtMs(
            current,
            current.nextRunAtMs,
            args.nowMs,
          );
        }
        await this.saveTaskRecord(
          db,
          {
            ...current,
            lastRunAtMs: args.run.scheduledForMs,
            nextRunAtMs,
            runNowAtMs: undefined,
            status:
              args.status === "blocked"
                ? "blocked"
                : nextRunAtMs
                  ? current.status
                  : "paused",
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
        await this.saveTaskRecord(
          db,
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

      await this.saveTaskRecord(
        db,
        {
          ...current,
          lastRunAtMs: args.run.scheduledForMs,
          nextRunAtMs,
          status:
            args.status === "blocked"
              ? "blocked"
              : nextRunAtMs
                ? "active"
                : "paused",
          statusReason:
            args.status === "blocked" ? args.errorMessage : undefined,
          updatedAtMs: args.nowMs,
        },
        current,
      );
    });
  }

  private async updateRun(
    runId: string,
    update: (run: ScheduledRun) => ScheduledRun | undefined,
  ): Promise<ScheduledRun | undefined> {
    return await withSqlLock(
      this.db,
      indexLockKey(runKey(runId)),
      async (db) => {
        const current = await getRunFromSql(db, runId);
        if (!current) {
          return undefined;
        }
        const next = update(current);
        if (!next) {
          return undefined;
        }
        await upsertSqlRun(db, next);
        return next;
      },
    );
  }
}

/** Create a scheduler store backed by the plugin SQL database. */
export function createSchedulerSqlStore(db: SchedulerDb): SchedulerStore {
  return new SqlSchedulerStore(db);
}

/** Create a read-only scheduler operational store backed by SQL. */
export function createSchedulerOperationalSqlStore(
  db: SchedulerDb,
): SchedulerOperationalStore {
  return new SqlSchedulerStore(db);
}

/** Copy retained scheduler plugin-state records into the scheduler SQL tables. */
export async function migrateSchedulerStateToSql(args: {
  db: SchedulerDb;
  state: PluginState;
}): Promise<{
  existing: number;
  migrated: number;
  missing: number;
  scanned: number;
}> {
  const store = createSchedulerSqlStore(args.db);
  const ids = await getIndex(args.state, globalTaskIndexKey());
  let existing = 0;
  let migrated = 0;
  let missing = 0;
  const migratedTasks: ScheduledTask[] = [];

  for (const id of ids) {
    const rawTask = await args.state.get(taskKey(id));
    const task =
      parseStoredTask(rawTask) ?? parseLegacyStoredTaskForMigration(rawTask);
    if (!task) {
      missing += 1;
      continue;
    }
    migratedTasks.push(task);
    if (await store.getTask(task.id)) {
      existing += 1;
      continue;
    }
    await store.saveTask(task);
    migrated += 1;
  }

  const runs = await listIncompleteRunsForTasksFromState(
    args.state,
    migratedTasks,
  );
  for (const run of runs) {
    if (await store.getRun(run.id)) {
      existing += 1;
      continue;
    }
    await upsertSqlRun(args.db, run);
    migrated += 1;
  }

  return {
    existing,
    migrated,
    missing,
    scanned: ids.length + runs.length,
  };
}
