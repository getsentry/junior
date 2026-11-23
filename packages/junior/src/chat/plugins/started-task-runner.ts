/**
 * Run and recover plugin tasks that `tasks.start` started.
 *
 * The task row is the lease: each run claims it and counts one attempt. A
 * failed attempt throws to the queue, which delivers the message again after
 * the fixed plugin task backoff. The last allowed attempt ends the task as
 * `failed`. The heartbeat sends a task again when its message was lost.
 */
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type {
  PluginRegistration,
  PluginStartedTaskContext,
} from "@sentry/junior-plugin-api";
import { createCodeChangePublisher } from "@/chat/code/publisher";
import { getDb } from "@/chat/db";
import { mapBounded } from "@/chat/fan-out";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { logError, logException, withSpan } from "@/chat/logging";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginConversationChanges } from "@/chat/plugins/conversation-changes";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { juniorPluginTasks } from "@/db/schema/plugin-tasks";
import { getRegistrations } from "./agent-hooks";
import {
  PLUGIN_TASK_MAX_DELIVERIES,
  type StartedPluginTaskMessage,
} from "./task-queue";
import type { SendPluginTask } from "./task-runner";
import { PLUGIN_TASK_LEASE_MS, startedTaskDefinition } from "./task-start";

// Lost tasks that one heartbeat sends again.
const PLUGIN_TASK_RECOVERY_LIMIT = 50;

const OPEN_STATUSES = ["pending", "running"] as const;

type ClaimedTask = typeof juniorPluginTasks.$inferSelect;

function taskAttributes(task: { name: string; plugin: string }) {
  return { "app.plugin.name": task.plugin, "app.plugin.task": task.name };
}

/** Write the outcome of one run, unless a later run claimed the task. */
async function settleTask(
  task: ClaimedTask,
  status: "pending" | "completed" | "failed",
): Promise<void> {
  const nowMs = Date.now();
  await getDb()
    .update(juniorPluginTasks)
    .set({
      leaseExpiresAt: new Date(nowMs + PLUGIN_TASK_LEASE_MS),
      status,
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorPluginTasks.id, task.id),
        eq(juniorPluginTasks.attempts, task.attempts),
      ),
    );
}

function startedTaskContext(
  plugin: PluginRegistration,
  task: ClaimedTask,
  payload: unknown,
  options: { showInboxItem?: ShowInboxItem | undefined },
): PluginStartedTaskContext {
  const pluginName = plugin.manifest.name;
  return {
    annotations: {
      forConversation: (conversationId) =>
        createPluginAnnotations({
          conversationId,
          db: getDb(),
          plugin: pluginName,
        }),
    },
    cache: createPluginCache(pluginName),
    codeChanges: createCodeChangePublisher(pluginName),
    conversationChanges: createPluginConversationChanges({
      plugin: pluginName,
      show: options.showInboxItem ?? (async () => {}),
    }),
    db: getDb(),
    key: task.key,
    log: createPluginLogger(pluginName),
    name: task.name,
    payload,
    plugin: { name: pluginName },
    state: createPluginState(pluginName),
  };
}

/**
 * Run one attempt of a started task. A delivery for a task that ended, or
 * that another run holds, does nothing.
 */
export async function processStartedPluginTask(
  message: StartedPluginTaskMessage,
  options: { showInboxItem?: ShowInboxItem | undefined } = {},
): Promise<void> {
  const nowMs = Date.now();
  const [task] = await getDb()
    .update(juniorPluginTasks)
    .set({
      attempts: sql`${juniorPluginTasks.attempts} + 1`,
      leaseExpiresAt: new Date(nowMs + PLUGIN_TASK_LEASE_MS),
      status: "running",
      updatedAt: new Date(nowMs),
    })
    .where(
      and(
        eq(juniorPluginTasks.id, message.taskId),
        lt(juniorPluginTasks.attempts, PLUGIN_TASK_MAX_DELIVERIES),
        or(
          eq(juniorPluginTasks.status, "pending"),
          and(
            eq(juniorPluginTasks.status, "running"),
            lte(juniorPluginTasks.leaseExpiresAt, new Date(nowMs)),
          ),
        ),
      ),
    )
    .returning();
  if (!task) return;
  const plugin = getRegistrations().find(
    (candidate) => candidate.manifest.name === task.plugin,
  );
  const definition = startedTaskDefinition(plugin?.tasks, task.name);
  const payload = definition?.payload.safeParse(task.payload);
  if (!plugin || !definition || !payload?.success) {
    // A retry cannot fix a missing task or a payload it cannot read.
    await settleTask(task, "failed");
    logException(
      new Error(
        `Plugin task "${task.plugin}.${task.name}" is not registered or cannot read its payload`,
        { cause: payload?.error },
      ),
      "plugin.task.failed",
      taskAttributes(task),
    );
    return;
  }
  try {
    await withSpan(
      `plugin.task ${task.plugin}.${task.name}`,
      "plugin.task",
      {},
      async () => {
        await definition.run(
          startedTaskContext(plugin, task, payload.data, options),
        );
      },
      { ...taskAttributes(task), "app.plugin.task.attempt": task.attempts },
    );
  } catch (error) {
    if (task.attempts < PLUGIN_TASK_MAX_DELIVERIES) {
      await settleTask(task, "pending");
      throw error;
    }
    await settleTask(task, "failed");
    logException(error, "plugin.task.failed", {
      ...taskAttributes(task),
      "app.plugin.task.attempt": task.attempts,
    });
    return;
  }
  await settleTask(task, "completed");
}

/**
 * Send again the started tasks whose lease expired while they were open,
 * because their queue message was lost or their run stopped. A task that
 * used its last attempt ends as `failed`.
 */
export async function recoverStartedPluginTasks(args: {
  nowMs: number;
  send: SendPluginTask;
}): Promise<void> {
  const now = new Date(args.nowMs);
  const expired = and(
    inArray(juniorPluginTasks.status, OPEN_STATUSES),
    lte(juniorPluginTasks.leaseExpiresAt, now),
  );
  const tasks = await getDb()
    .select({
      attempts: juniorPluginTasks.attempts,
      id: juniorPluginTasks.id,
      name: juniorPluginTasks.name,
      plugin: juniorPluginTasks.plugin,
    })
    .from(juniorPluginTasks)
    .where(expired)
    .orderBy(juniorPluginTasks.leaseExpiresAt)
    .limit(PLUGIN_TASK_RECOVERY_LIMIT);
  await mapBounded(tasks, async (task) => {
    try {
      const exhausted = task.attempts >= PLUGIN_TASK_MAX_DELIVERIES;
      // Take the lease first, so one heartbeat sends the task once.
      const [taken] = await getDb()
        .update(juniorPluginTasks)
        .set({
          leaseExpiresAt: new Date(args.nowMs + PLUGIN_TASK_LEASE_MS),
          status: exhausted ? "failed" : "pending",
          updatedAt: now,
        })
        .where(
          and(
            eq(juniorPluginTasks.id, task.id),
            eq(juniorPluginTasks.attempts, task.attempts),
            expired,
          ),
        )
        .returning({ id: juniorPluginTasks.id });
      if (!taken) return;
      if (exhausted) {
        logError("plugin.task.failed", {
          ...taskAttributes(task),
          "app.plugin.task.attempt": task.attempts,
          "app.reason": "The last run stopped before it finished",
        });
        return;
      }
      await args.send({
        name: task.name,
        plugin: task.plugin,
        taskId: task.id,
      });
    } catch (error) {
      // The lease expires again, and a later heartbeat retries.
      logException(error, "plugin.task.recovery.failed", taskAttributes(task));
    }
  });
}
