/**
 * Plugin background-task orchestration.
 *
 * Core schedules tasks from completed sessions and exposes plugins only a
 * bounded session projection rather than live runtime internals or queue
 * envelopes.
 */
import type {
  PluginRegistration,
  PluginSessionContext,
  PluginSessionMessage,
  PluginTaskContext,
  PluginTaskParams,
  Requester,
} from "@sentry/junior-plugin-api";
import {
  pluginSessionContextSchema,
  pluginTaskParamsSchema,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginEmbedder, createPluginModel } from "@/chat/plugins/model";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import { createRequester } from "@/chat/requester";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  getSuccessfulToolCalls,
  stripRuntimeTurnContext,
} from "@/chat/respond-helpers";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { getPlugins } from "./agent-hooks";
import {
  createPluginTaskQueueMessage,
  type PluginTaskQueueMessage,
} from "./task-queue-signing";
import { getVercelPluginTaskQueue, type PluginTaskQueue } from "./task-queue";

type SessionCompletedTaskParams = PluginTaskParams;

export interface ScheduleSessionCompletedPluginTasksOptions {
  enqueue?: boolean;
  queue?: PluginTaskQueue;
}

export interface ScheduledPluginTask {
  id: string;
  message: PluginTaskQueueMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textPart(value: unknown): string | undefined {
  if (
    isRecord(value) &&
    value.type === "text" &&
    typeof value.text === "string"
  ) {
    return value.text;
  }
  return undefined;
}

function messageText(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return sanitizeText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return sanitizeText(content.map(textPart).filter(Boolean).join("\n"));
}

function sanitizeText(text: string): string {
  return text
    .replace(
      /<data_base64>[\s\S]*?<\/data_base64>/g,
      "<data_base64>[omitted]</data_base64>",
    )
    .replace(
      /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,
      "[image data omitted]",
    )
    .replaceAll("\u0000", " ")
    .trim();
}

function sessionMessage(message: PiMessage): PluginSessionMessage | undefined {
  const role = getPiMessageRole(message);
  if (role !== "user" && role !== "assistant") {
    return undefined;
  }
  const text = messageText(message);
  if (!text) {
    return undefined;
  }
  return { role, text };
}

function requesterForSession(
  record: Awaited<ReturnType<typeof getAgentTurnSessionRecord>>,
): Requester | undefined {
  if (!record?.source) {
    return undefined;
  }
  if (record.source.platform === "local") {
    return {
      platform: "local",
      userId: "local-cli",
      userName: "local",
      fullName: "Local CLI",
    };
  }
  return createRequester(
    {
      email: record.requester?.email,
      fullName: record.requester?.fullName,
      platform: "slack",
      teamId: record.requester?.teamId ?? record.source.teamId,
      userId: record.requester?.slackUserId,
      userName: record.requester?.slackUserName,
    },
    {
      platform: "slack",
      teamId: record.source.teamId,
      userId: record.requester?.slackUserId,
    },
  ) as Requester | undefined;
}

/** Load the bounded completed-session projection exposed to plugin tasks. */
async function loadPluginSession(
  params: SessionCompletedTaskParams,
): Promise<PluginSessionContext> {
  const record = await getAgentTurnSessionRecord(
    params.conversationId,
    params.sessionId,
  );
  if (!record) {
    throw new Error("Completed plugin task session record is unavailable");
  }
  if (record.state !== "completed") {
    throw new Error("Completed plugin task session record is not completed");
  }
  if (!record.source || !record.destination) {
    throw new Error(
      "Completed plugin task session record is missing source or destination",
    );
  }
  const requester = requesterForSession(record);
  const sessionMessages = stripRuntimeTurnContext(
    record.piMessages.slice(record.turnStartMessageIndex ?? 0),
  );
  return pluginSessionContextSchema.parse({
    completedAtMs: record.updatedAtMs,
    conversationId: record.conversationId,
    destination: record.destination,
    messages: sessionMessages
      .map(sessionMessage)
      .filter((message): message is PluginSessionMessage => Boolean(message)),
    ...(requester ? { requester } : {}),
    sessionId: record.sessionId,
    source: record.source,
    toolCalls: getSuccessfulToolCalls(sessionMessages),
  });
}

/** Build the plugin-facing context for one claimed task attempt. */
function taskPluginContext(
  plugin: PluginRegistration,
  message: PluginTaskQueueMessage,
): PluginTaskContext {
  const pluginName = plugin.manifest.name;
  const sessionParams = pluginTaskParamsSchema.parse(message.params);
  return {
    db: getDb(),
    embedder: createPluginEmbedder(pluginName),
    id: message.id,
    log: createPluginLogger(pluginName),
    model: createPluginModel(pluginName),
    name: message.name,
    params: sessionParams,
    plugin: { name: pluginName },
    session: {
      async load() {
        return await loadPluginSession(sessionParams);
      },
    },
    state: createPluginState(pluginName),
  };
}

function findPluginTask(message: PluginTaskQueueMessage) {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === message.plugin,
  );
  const task = plugin?.tasks?.[message.name];
  if (!plugin || !task) {
    return undefined;
  }
  return { plugin, task };
}

/** Schedule all plugin tasks interested in a completed agent-run session. */
export async function scheduleSessionCompletedPluginTasks(
  params: SessionCompletedTaskParams,
  options: ScheduleSessionCompletedPluginTasksOptions = {},
): Promise<ScheduledPluginTask[]> {
  const scheduled: ScheduledPluginTask[] = [];
  const coreParams = pluginTaskParamsSchema.parse(params);
  const shouldEnqueue = options.enqueue !== false;
  const queue = shouldEnqueue
    ? (options.queue ?? getVercelPluginTaskQueue())
    : undefined;
  for (const plugin of getPlugins()) {
    for (const name of Object.keys(plugin.tasks ?? {})) {
      const message = createPluginTaskQueueMessage({
        name,
        params: coreParams,
        plugin: plugin.manifest.name,
        trigger: "session.completed",
      });
      scheduled.push({ id: message.id, message });
      if (queue) {
        await queue.send(message);
      }
    }
  }
  return scheduled;
}

/** Execute one verified plugin task request. */
export async function processPluginTask(
  message: PluginTaskQueueMessage,
): Promise<void> {
  const resolved = findPluginTask(message);
  if (!resolved) {
    throw new Error(
      `Plugin task "${message.plugin}.${message.name}" is not registered`,
    );
  }
  await resolved.task.run(taskPluginContext(resolved.plugin, message));
}
