import type { Lock, StateAdapter } from "chat";
import { getStateAdapter } from "@/chat/state/adapter";
import type { ScheduledRun, ScheduledTask } from "@/chat/scheduler/types";

const SCHEDULER_KEY_PREFIX = "junior:scheduler";
const SCHEDULER_RECORD_TTL_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const SCHEDULED_RUN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 6 * 60 * 60 * 1000;
const LOCK_TTL_MS = 10_000;

export interface SchedulerStore {
  claimDueRuns(args: { limit: number; nowMs: number }): Promise<ScheduledRun[]>;
  getRun(runId: string): Promise<ScheduledRun | undefined>;
  getTask(taskId: string): Promise<ScheduledTask | undefined>;
  listTasksForTeam(teamId: string): Promise<ScheduledTask[]>;
  markRunBlocked(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  markRunCompleted(args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  markRunFailed(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  markRunStarted(args: {
    nowMs: number;
    runId: string;
  }): Promise<ScheduledRun | undefined>;
  saveTask(task: ScheduledTask): Promise<void>;
}

function taskKey(taskId: string): string {
  return `${SCHEDULER_KEY_PREFIX}:task:${taskId}`;
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
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock: Lock | null = await state.acquireLock(key, LOCK_TTL_MS);
  if (!lock) {
    throw new Error(`Could not acquire scheduler lock for ${key}`);
  }

  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

async function addToIndex(
  state: StateAdapter,
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
  state: StateAdapter,
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

async function getIndex(state: StateAdapter, key: string): Promise<string[]> {
  const values = (await state.get<string[]>(key)) ?? [];
  return unique(
    values.filter((value): value is string => typeof value === "string"),
  );
}

async function clearActiveRun(
  state: StateAdapter,
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

function isDueTask(
  task: ScheduledTask,
  nowMs: number,
): task is ScheduledTask & {
  nextRunAtMs: number;
} {
  return (
    task.status === "active" &&
    typeof task.nextRunAtMs === "number" &&
    Number.isFinite(task.nextRunAtMs) &&
    task.nextRunAtMs <= nowMs
  );
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

class StateAdapterSchedulerStore implements SchedulerStore {
  private readonly state: StateAdapter;

  constructor(state: StateAdapter) {
    this.state = state;
  }

  async saveTask(task: ScheduledTask): Promise<void> {
    await this.state.connect();
    const current =
      (await this.state.get<ScheduledTask>(taskKey(task.id))) ?? undefined;
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
    await this.state.connect();
    return (await this.state.get<ScheduledTask>(taskKey(taskId))) ?? undefined;
  }

  async listTasksForTeam(teamId: string): Promise<ScheduledTask[]> {
    await this.state.connect();
    const ids = await getIndex(this.state, teamTaskIndexKey(teamId));
    const tasks = await Promise.all(ids.map((id) => this.getTask(id)));
    return tasks
      .filter((task): task is ScheduledTask => Boolean(task))
      .filter((task) => task.status !== "deleted")
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  async claimDueRuns(args: {
    limit: number;
    nowMs: number;
  }): Promise<ScheduledRun[]> {
    await this.state.connect();
    const ids = await getIndex(this.state, globalTaskIndexKey());
    const runs: ScheduledRun[] = [];

    for (const id of ids) {
      if (runs.length >= args.limit) {
        break;
      }

      const task = await this.getTask(id);
      if (!task || !isDueTask(task, args.nowMs)) {
        continue;
      }

      const scheduledForMs = task.nextRunAtMs;
      const runId = buildRunId(task.id, scheduledForMs);
      const activeClaimed = await this.state.setIfNotExists(
        activeRunKey(task.id),
        { claimedAtMs: args.nowMs, runId, scheduledForMs },
        CLAIM_TTL_MS,
      );
      if (!activeClaimed) {
        continue;
      }

      const claimed = await this.state.setIfNotExists(
        claimKey(task.id, scheduledForMs),
        { claimedAtMs: args.nowMs },
        CLAIM_TTL_MS,
      );
      if (!claimed) {
        await clearActiveRun(this.state, task.id, runId);
        continue;
      }

      const run = buildScheduledRun({
        claimedAtMs: args.nowMs,
        scheduledForMs,
        task,
      });
      await this.state.set(runKey(run.id), run, SCHEDULED_RUN_TTL_MS);
      runs.push(run);
    }

    return runs;
  }

  async getRun(runId: string): Promise<ScheduledRun | undefined> {
    await this.state.connect();
    return (await this.state.get<ScheduledRun>(runKey(runId))) ?? undefined;
  }

  async markRunStarted(args: {
    nowMs: number;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    return await this.updateRun(args.runId, (run) => ({
      ...run,
      startedAtMs: args.nowMs,
      status: "running",
    }));
  }

  async markRunCompleted(args: {
    completedAtMs: number;
    resultMessageTs?: string;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) => ({
      ...run,
      completedAtMs: args.completedAtMs,
      resultMessageTs: args.resultMessageTs,
      status: "completed",
    }));
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async markRunFailed(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) => ({
      ...run,
      completedAtMs: args.completedAtMs,
      errorMessage: args.errorMessage,
      status: "failed",
    }));
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  async markRunBlocked(args: {
    completedAtMs: number;
    errorMessage: string;
    runId: string;
  }): Promise<ScheduledRun | undefined> {
    const next = await this.updateRun(args.runId, (run) => ({
      ...run,
      completedAtMs: args.completedAtMs,
      errorMessage: args.errorMessage,
      status: "blocked",
    }));
    if (next) {
      await clearActiveRun(this.state, next.taskId, next.id);
    }
    return next;
  }

  private async updateRun(
    runId: string,
    update: (run: ScheduledRun) => ScheduledRun,
  ): Promise<ScheduledRun | undefined> {
    await this.state.connect();
    return await withLock(this.state, indexLockKey(runKey(runId)), async () => {
      const current = await this.getRun(runId);
      if (!current) {
        return undefined;
      }
      const next = update(current);
      await this.state.set(runKey(runId), next, SCHEDULED_RUN_TTL_MS);
      return next;
    });
  }
}

/** Create the production scheduler store backed by Junior's state adapter. */
export function createStateSchedulerStore(
  stateAdapter: StateAdapter = getStateAdapter(),
): SchedulerStore {
  return new StateAdapterSchedulerStore(stateAdapter);
}
