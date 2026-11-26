/**
 * Run plugin tasks that `tasks.start` started.
 *
 * The queue message carries the payload. A failed run throws to the queue,
 * which delivers the message again after the fixed plugin task backoff. The
 * last allowed delivery logs `plugin.task.failed` and acknowledges.
 */
import type {
  PluginRegistration,
  PluginStartedTaskContext,
} from "@sentry/junior-plugin-api";
import { createPluginCodeChanges } from "@/chat/code/plugin-code-changes";
import { getDb } from "@/chat/db";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import { createPluginInboxItems } from "@/chat/inbox-items/plugin";
import { logException, withSpan } from "@/chat/logging";
import { createPluginConversationAnnotations } from "@/chat/plugins/annotations";
import { createPluginCache } from "@/chat/plugins/cache";
import { createPluginConversationChanges } from "@/chat/plugins/conversation-changes";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { createPluginUsers } from "@/chat/plugins/viewer";
import {
  type AppEventPublisher,
  createPluginEventPublisher,
  getRegistrations,
} from "./agent-hooks";
import {
  PLUGIN_TASK_MAX_DELIVERIES,
  type StartedPluginTaskMessage,
} from "./task-queue";
import type { SendPluginTask } from "./task-runner";
import { createPluginTaskStarter, startedTaskDefinition } from "./task-start";

interface StartedTaskOptions {
  /** Queue delivery of this message, when the queue reports it. */
  deliveryCount?: number | undefined;
  /** Core event publisher, which the queue consumer of the app supplies. */
  events: AppEventPublisher;
  /** Sends the tasks that this task starts. */
  sendPluginTask: SendPluginTask;
  showInboxItem?: ShowInboxItem | undefined;
}

function startedTaskContext(
  plugin: PluginRegistration,
  name: string,
  payload: unknown,
  options: StartedTaskOptions,
): PluginStartedTaskContext {
  const pluginName = plugin.manifest.name;
  return {
    annotations: createPluginConversationAnnotations({
      db: getDb,
      plugin: pluginName,
    }),
    cache: createPluginCache(pluginName),
    codeChanges: createPluginCodeChanges(pluginName),
    conversationChanges: createPluginConversationChanges({
      plugin: pluginName,
      show: options.showInboxItem ?? (async () => {}),
    }),
    db: getDb(),
    events: createPluginEventPublisher(plugin, options.events),
    inboxItems: {
      forConversation: (conversationId) =>
        createPluginInboxItems({
          conversationId,
          plugin: pluginName,
          show: options.showInboxItem ?? (async () => {}),
        }),
    },
    lastDelivery: (options.deliveryCount ?? 0) >= PLUGIN_TASK_MAX_DELIVERIES,
    log: createPluginLogger(pluginName),
    name,
    payload,
    plugin: { name: pluginName },
    state: createPluginState(pluginName),
    tasks: createPluginTaskStarter({
      plugin: pluginName,
      send: options.sendPluginTask,
      tasks: plugin.tasks,
    }),
    users: createPluginUsers(pluginName),
  };
}

/** Run one delivery of a started task. */
export async function processStartedPluginTask(
  message: StartedPluginTaskMessage,
  options: StartedTaskOptions,
): Promise<void> {
  const attributes = {
    "app.plugin.name": message.plugin,
    "app.plugin.task": message.name,
    "app.plugin.task.attempt": options.deliveryCount,
  };
  const plugin = getRegistrations().find(
    (candidate) => candidate.manifest.name === message.plugin,
  );
  const definition = startedTaskDefinition(plugin?.tasks, message.name);
  const payload = definition?.payload.safeParse(message.payload);
  if (!plugin || !definition || !payload?.success) {
    // A retry cannot fix a missing task or a payload it cannot read.
    logException(
      new Error(
        `Plugin task "${message.plugin}.${message.name}" is not registered or cannot read its payload`,
        { cause: payload?.error },
      ),
      "plugin.task.failed",
      attributes,
    );
    return;
  }
  try {
    await withSpan(
      `plugin.task ${message.plugin}.${message.name}`,
      "plugin.task",
      {},
      async () => {
        await definition.run(
          startedTaskContext(plugin, message.name, payload.data, options),
        );
      },
      attributes,
    );
  } catch (error) {
    if ((options.deliveryCount ?? 0) < PLUGIN_TASK_MAX_DELIVERIES) {
      throw error;
    }
    logException(error, "plugin.task.failed", attributes);
  }
}
