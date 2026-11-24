/**
 * Start a plugin task from a plugin route or heartbeat.
 *
 * The signed queue message carries the task's JSON payload. Its idempotency
 * key is a hash of the plugin, task name, and key, so a second start for the
 * key does nothing while the queue keeps the message.
 */
import {
  pluginTaskStartInputSchema,
  type PluginStartedTaskDefinition,
  type PluginTasks,
  type PluginTaskStarter,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { startedPluginTaskIdempotencyKey } from "./task-queue";
import type { SendPluginTask } from "./task-runner";

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
      const { delaySeconds, key, name, payload } =
        pluginTaskStartInputSchema.parse(input);
      const task = startedTaskDefinition(args.tasks, name);
      if (!task) {
        throw new Error(
          `Plugin task "${pluginName}.${name}" has no payload schema, so tasks.start cannot start it`,
        );
      }
      // Send the JSON form, and check that the task can read it back.
      const json: unknown = JSON.parse(JSON.stringify(payload) ?? "null");
      const sent = z.json().parse(json);
      task.payload.parse(sent);
      await args.send(
        { name, payload: sent, plugin: pluginName },
        {
          delaySeconds,
          idempotencyKey: startedPluginTaskIdempotencyKey({
            key,
            name,
            plugin: pluginName,
          }),
        },
      );
    },
  };
}
