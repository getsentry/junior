/**
 * Plugin task execution started by eval scenarios and drained before cleanup.
 */
import { processPluginTask } from "@/chat/plugins/task-runner";
import type { PluginTaskQueueMessage } from "@/chat/plugins/task-queue";

const EVAL_PLUGIN_TASK_DRAIN_TIMEOUT_MS = 5_000;

interface PendingEvalPluginTask {
  abort(): void;
  promise: Promise<void>;
}

const pendingEvalPluginTasks = new Set<PendingEvalPluginTask>();

/** Run one plugin task inline and track it so cleanup can abort or join it. */
export async function processEvalPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  const controller = new AbortController();
  let task!: PendingEvalPluginTask;
  const promise = processPluginTask(message, {
    signal: controller.signal,
  }).finally(() => {
    pendingEvalPluginTasks.delete(task);
  });
  task = {
    abort() {
      controller.abort(new Error("Eval plugin task cleanup aborted task"));
    },
    promise,
  };
  pendingEvalPluginTasks.add(task);
  await promise;
}

/** Drain plugin tasks started by the eval harness before shared state cleanup. */
export async function drainPendingEvalPluginTasks(): Promise<void> {
  if (pendingEvalPluginTasks.size === 0) {
    return;
  }
  const tasks = [...pendingEvalPluginTasks];
  for (const task of tasks) {
    task.abort();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks.map((task) => task.promise)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for ${tasks.length} eval plugin task(s) to settle`,
            ),
          );
        }, EVAL_PLUGIN_TASK_DRAIN_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
