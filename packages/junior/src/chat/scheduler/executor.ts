import { buildScheduledTaskRunPrompt } from "@/chat/scheduler/prompt";
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

function shouldSkipRun(
  task: ScheduledTask,
  run: ScheduledRun,
): string | undefined {
  if (task.status === "deleted") {
    return `Scheduled task ${task.id} was deleted before the run started.`;
  }
  if (task.status !== "active") {
    return `Scheduled task ${task.id} was ${task.status} before the run started.`;
  }
  if (
    task.nextRunAtMs !== run.scheduledForMs &&
    task.runNowAtMs !== run.scheduledForMs
  ) {
    return `Scheduled task ${task.id} no longer targets ${new Date(run.scheduledForMs).toISOString()}.`;
  }
  return undefined;
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

  const skippedReason = shouldSkipRun(task, args.run);
  if (skippedReason) {
    return await args.store.markRunSkipped({
      runId: args.run.id,
      completedAtMs: args.nowMs,
      errorMessage: skippedReason,
    });
  }

  const startedRun = await args.store.markRunStarted({
    runId: args.run.id,
    claimedAtMs: args.run.claimedAtMs,
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
        startedAtMs: startedRun.startedAtMs!,
      });
      if (!completed) {
        return undefined;
      }
      await args.store.updateTaskAfterRun({
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
        startedAtMs: startedRun.startedAtMs!,
      });
      if (!blocked) {
        return undefined;
      }
      await args.store.updateTaskAfterRun({
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
      startedAtMs: startedRun.startedAtMs!,
    });
    if (!failed) {
      return undefined;
    }
    await args.store.updateTaskAfterRun({
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
      startedAtMs: startedRun.startedAtMs!,
    });
    if (!failed) {
      return undefined;
    }
    await args.store.updateTaskAfterRun({
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
  const completedRuns: ScheduledRun[] = [];

  for (let index = 0; index < args.limit; index += 1) {
    const run = await args.store.claimDueRun({
      nowMs: args.nowMs,
    });
    if (!run) {
      break;
    }
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
