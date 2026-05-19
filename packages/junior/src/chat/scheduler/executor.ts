import { buildScheduledTaskRunPrompt } from "@/chat/scheduler/prompt";
import { getNextRunAtMs } from "@/chat/scheduler/cadence";
import type { SchedulerStore } from "@/chat/scheduler/store";
import type { ScheduledRun, ScheduledTask } from "@/chat/scheduler/types";

export type ScheduledTaskRunResult =
  | {
      status: "completed";
      resultMessageTs?: string;
    }
  | {
      status: "blocked" | "failed";
      errorMessage: string;
    };

export interface ScheduledTaskRunner {
  run(args: {
    nowMs: number;
    prompt: string;
    run: ScheduledRun;
    task: ScheduledTask;
  }): Promise<ScheduledTaskRunResult>;
}

async function updateTaskAfterRun(args: {
  errorMessage?: string;
  nowMs: number;
  run: ScheduledRun;
  status: ScheduledTaskRunResult["status"];
  store: SchedulerStore;
  task: ScheduledTask;
}): Promise<void> {
  const current = await args.store.getTask(args.task.id);
  if (!current || current.status === "deleted") {
    return;
  }

  if (
    current.status !== "active" ||
    current.nextRunAtMs !== args.run.scheduledForMs
  ) {
    await args.store.saveTask({
      ...current,
      lastRunAtMs: args.run.scheduledForMs,
      updatedAtMs: args.nowMs,
      version: current.version + 1,
    });
    return;
  }

  const nextRunAtMs =
    args.status === "blocked"
      ? undefined
      : getNextRunAtMs(current, args.run.scheduledForMs, args.nowMs);

  await args.store.saveTask({
    ...current,
    lastRunAtMs: args.run.scheduledForMs,
    nextRunAtMs,
    status:
      args.status === "blocked" ? "blocked" : nextRunAtMs ? "active" : "paused",
    statusReason: args.status === "blocked" ? args.errorMessage : undefined,
    updatedAtMs: args.nowMs,
    version: current.version + 1,
  });
}

/** Execute one claimed scheduled run through the compiled task prompt. */
export async function executeScheduledRun(args: {
  nowMs: number;
  run: ScheduledRun;
  runner: ScheduledTaskRunner;
  store: SchedulerStore;
}): Promise<ScheduledRun | undefined> {
  const task = await args.store.getTask(args.run.taskId);
  if (!task) {
    return await args.store.markRunFailed({
      runId: args.run.id,
      completedAtMs: args.nowMs,
      errorMessage: `Scheduled task ${args.run.taskId} was not found`,
    });
  }

  const startedRun = await args.store.markRunStarted({
    runId: args.run.id,
    nowMs: args.nowMs,
  });
  if (!startedRun) {
    return undefined;
  }

  const prompt = buildScheduledTaskRunPrompt({
    task,
    run: startedRun,
    nowMs: args.nowMs,
  });

  try {
    const result = await args.runner.run({
      task,
      run: startedRun,
      prompt,
      nowMs: args.nowMs,
    });

    if (result.status === "completed") {
      const completed = await args.store.markRunCompleted({
        runId: startedRun.id,
        completedAtMs: args.nowMs,
        resultMessageTs: result.resultMessageTs,
      });
      await updateTaskAfterRun({
        store: args.store,
        task,
        run: startedRun,
        status: result.status,
        nowMs: args.nowMs,
      });
      return completed;
    }

    if (result.status === "blocked") {
      const blocked = await args.store.markRunBlocked({
        runId: startedRun.id,
        completedAtMs: args.nowMs,
        errorMessage: result.errorMessage,
      });
      await updateTaskAfterRun({
        store: args.store,
        task,
        run: startedRun,
        status: result.status,
        errorMessage: result.errorMessage,
        nowMs: args.nowMs,
      });
      return blocked;
    }

    const failed = await args.store.markRunFailed({
      runId: startedRun.id,
      completedAtMs: args.nowMs,
      errorMessage: result.errorMessage,
    });
    await updateTaskAfterRun({
      store: args.store,
      task,
      run: startedRun,
      status: result.status,
      errorMessage: result.errorMessage,
      nowMs: args.nowMs,
    });
    return failed;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failed = await args.store.markRunFailed({
      runId: startedRun.id,
      completedAtMs: args.nowMs,
      errorMessage,
    });
    await updateTaskAfterRun({
      store: args.store,
      task,
      run: startedRun,
      status: "failed",
      errorMessage,
      nowMs: args.nowMs,
    });
    return failed;
  }
}

/** Claim due scheduled runs and execute each through the supplied runner. */
export async function processDueScheduledRuns(args: {
  limit: number;
  nowMs: number;
  runner: ScheduledTaskRunner;
  store: SchedulerStore;
}): Promise<ScheduledRun[]> {
  const claimedRuns = await args.store.claimDueRuns({
    limit: args.limit,
    nowMs: args.nowMs,
  });
  const completedRuns: ScheduledRun[] = [];

  for (const run of claimedRuns) {
    const completed = await executeScheduledRun({
      store: args.store,
      runner: args.runner,
      run,
      nowMs: args.nowMs,
    });
    if (completed) {
      completedRuns.push(completed);
    }
  }

  return completedRuns;
}
