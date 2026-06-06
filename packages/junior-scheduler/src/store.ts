import type {
  AgentPluginReadState,
  AgentPluginState,
} from "@sentry/junior-plugin-api";
import { getNextRunAtMs } from "./cadence";
import type { ScheduledRun, ScheduledTask } from "./types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";
const SCHEDULER_RECORD_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const SCHEDULED_RUN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 6 * 60 * 60 * 1000;
const PENDING_CLAIM_STALE_MS = 60_000;
const MISSED_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10_000;

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
  state: AgentPluginState,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await state.withLock(key, LOCK_TTL_MS, callback);
}

async function addToIndex(
  state: AgentPluginState,
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
  state: AgentPluginState,
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
  state: AgentPluginReadState,
  key: string,
): Promise<string[]> {
  const values = (await state.get<string[]>(key)) ?? [];
  return unique(
    values.filter((value): value is string => typeof value === "string"),
  );
}

async function clearActiveRun(
  state: AgentPluginState,
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
  state: AgentPluginState,
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

  const activeRun =
    (await state.get<ScheduledRun>(runKey(active.runId))) ?? undefined;
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
  const idempotencyKey = `${args.task.id}:${args.scheduledForMs}`;
  return {
    id: buildRunId(args.task.id, args.scheduledForMs),
    attempt: 1,
    claimedAtMs: args.claimedAtMs,
    idempotencyKey,
    scheduledForMs: args.scheduledForMs,
    status: "pending",
    taskId: args.task.id,
    taskVersion: args.task.version,
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

async function getTaskFromState(
  state: AgentPluginReadState,
  taskId: string,
): Promise<ScheduledTask | undefined> {
  return (await state.get<ScheduledTask>(taskKey(taskId))) ?? undefined;
}

async function listTasksFromState(
  state: AgentPluginReadState,
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
  state: AgentPluginReadState,
  runId: string,
): Promise<ScheduledRun | undefined> {
  return (await state.get<ScheduledRun>(runKey(runId))) ?? undefined;
}

async function listIncompleteRunsForTasksFromState(
  state: AgentPluginReadState,
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
  private readonly state: AgentPluginReadState;

  constructor(state: AgentPluginReadState) {
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
  private readonly state: AgentPluginState;

  constructor(state: AgentPluginState) {
    this.state = state;
  }

  async saveTask(task: ScheduledTask): Promise<void> {
    await withLock(this.state, taskLockKey(task.id), async () => {
      const current =
        (await this.state.get<ScheduledTask>(taskKey(task.id))) ?? undefined;
      await this.saveTaskRecord(task, current);
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
        (await this.state.get<ScheduledTask>(taskKey(args.task.id))) ??
        undefined;
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
          version: current.version + 1,
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
        (await this.state.get<ScheduledTask>(taskKey(args.run.taskId))) ??
        undefined;
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
            version: current.version + 1,
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
            version: current.version + 1,
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
          version: current.version + 1,
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
export function createSchedulerStore(state: AgentPluginState): SchedulerStore {
  return new PluginStateSchedulerStore(state);
}

/** Create a read-only scheduler store for operational reporting. */
export function createSchedulerOperationalStore(
  state: AgentPluginReadState,
): SchedulerOperationalStore {
  return new PluginStateSchedulerOperationalStore(state);
}
