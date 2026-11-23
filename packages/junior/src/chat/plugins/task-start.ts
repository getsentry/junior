/**
 * Start a plugin task from a plugin route or heartbeat.
 *
 * Core stores the task and its JSON payload before it sends the small signed
 * queue message, so a lost message only delays the task. The heartbeat sends
 * it again.
 */
import { randomUUID } from "node:crypto";
import {
  pluginTaskStartInputSchema,
  type PluginStartedTaskDefinition,
  type PluginTasks,
  type PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { juniorPluginTasks } from "@/db/schema/plugin-tasks";
import type { SendPluginTask } from "./task-runner";

/**
 * How long a task may stay `pending` or `running` before the heartbeat sends
 * it again. It is longer than a run and the longest retry delay.
 */
export const PLUGIN_TASK_LEASE_MS = 10 * 60 * 1000;

/** Return the task that `tasks.start` can start, or undefined. */
export function startedTaskDefinition(
  tasks: PluginTasks | undefined,
  name: string,
): PluginStartedTaskDefinition | undefined {
  if (!tasks || !Object.hasOwn(tasks, name)) return undefined;
  const task = tasks[name];
  return task?.payload ? task : undefined;
}

/** Create `ctx.tasks` for one plugin's route or heartbeat context. */
export function createPluginTaskStarter(args: {
  plugin: string;
  send: SendPluginTask;
  tasks: PluginTasks | undefined;
}): PluginTaskStarter {
  const pluginName = args.plugin;
  return {
    async start(input) {
      const { key, name, payload } = pluginTaskStartInputSchema.parse(input);
      const task = startedTaskDefinition(args.tasks, name);
      if (!task) {
        throw new Error(
          `Plugin task "${pluginName}.${name}" has no payload schema, so tasks.start cannot start it`,
        );
      }
      // Store the JSON form, and check that the task can read it back.
      const stored: unknown = JSON.parse(JSON.stringify(payload) ?? "null");
      task.payload.parse(stored);
      const now = Date.now();
      const [row] = await getDb()
        .insert(juniorPluginTasks)
        .values({
          attempts: 0,
          createdAt: new Date(now),
          id: randomUUID(),
          key,
          leaseExpiresAt: new Date(now + PLUGIN_TASK_LEASE_MS),
          name,
          payload: stored,
          plugin: pluginName,
          status: "pending",
          updatedAt: new Date(now),
        })
        .onConflictDoNothing({
          target: [juniorPluginTasks.plugin, juniorPluginTasks.key],
        })
        .returning({ id: juniorPluginTasks.id });
      if (!row) return;
      await args.send({ name, plugin: pluginName, taskId: row.id });
    },
  };
}
