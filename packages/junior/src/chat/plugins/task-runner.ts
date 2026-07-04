/**
 * Plugin background-task orchestration.
 *
 * Core schedules tasks from completed sessions and exposes plugins only a
 * bounded run projection rather than live runtime internals or queue
 * payloads.
 */
import type {
  PluginRegistration,
  PluginRunContext,
  PluginRunTranscriptEntry,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { pluginRunContextSchema } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginEmbedder, createPluginModel } from "@/chat/plugins/model";
import { createPluginState } from "@/chat/plugins/state";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  stripRuntimeTurnContext,
} from "@/chat/agent-run-helpers";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { getPlugins } from "./agent-hooks";
import {
  pluginTaskId,
  pluginTaskParamsSchema,
  type PluginTaskParams,
  type PluginTaskQueueMessage,
} from "./task-message";
import { sendVercelPluginTask } from "./task-queue";
import { getStateAdapter } from "@/chat/state/adapter";
import type { Lock } from "chat";

const PLUGIN_TASK_LOCK_TTL_MS = 5 * 60 * 1000;

export interface ScheduleSessionCompletedPluginTasksOptions {
  send?: (message: PluginTaskQueueMessage) => Promise<void>;
}

interface ProcessPluginTaskOptions {
  signal?: AbortSignal;
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

function toolResultText(message: PiMessage): string {
  const record = message as unknown as Record<string, unknown>;
  const parts = [
    messageText(message),
    record.output,
    record.result,
    record.stdout,
    record.stderr,
    record.toolResult,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return sanitizeText(parts.join("\n"));
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

function runTranscriptEntry(
  message: PiMessage,
): PluginRunTranscriptEntry | undefined {
  const role = getPiMessageRole(message);
  if (role === "user" || role === "assistant") {
    const text = messageText(message);
    if (!text) {
      return undefined;
    }
    return { type: "message", role, text };
  }

  if (!isToolResultMessage(message)) {
    return undefined;
  }
  const toolName = normalizeToolNameFromResult(message);
  if (!toolName) {
    return undefined;
  }
  const text = toolResultText(message);
  return {
    type: "toolResult",
    toolName,
    isError: isToolResultError(message),
    ...(text ? { text } : {}),
  };
}

async function withPluginTaskLock<T>(
  taskId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  await state.connect();
  const lock: Lock | null = await state.acquireLock(
    `plugin:task:${taskId}`,
    PLUGIN_TASK_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(`Could not acquire plugin task lock for ${taskId}`);
  }

  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

/** Load the bounded completed-run projection exposed to plugin tasks. */
async function loadPluginRun(
  params: PluginTaskParams,
): Promise<PluginRunContext> {
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
  const sessionMessages = stripRuntimeTurnContext(
    record.piMessages.slice(record.turnStartMessageIndex ?? 0),
  );
  return pluginRunContextSchema.parse({
    completedAtMs: record.updatedAtMs,
    conversationId: record.conversationId,
    destination: record.destination,
    ...(record.requester ? { requester: record.requester } : {}),
    runId: record.sessionId,
    source: record.source,
    transcript: sessionMessages
      .map(runTranscriptEntry)
      .filter((entry): entry is PluginRunTranscriptEntry => Boolean(entry)),
  });
}

/** Build the plugin-facing context for one claimed task attempt. */
function taskPluginContext(
  plugin: PluginRegistration,
  message: PluginTaskQueueMessage,
  options: ProcessPluginTaskOptions = {},
): PluginTaskContext {
  const pluginName = plugin.manifest.name;
  const sessionParams = pluginTaskParamsSchema.parse(message.params);
  return {
    db: getDb(),
    embedder: createPluginEmbedder(pluginName, {
      signal: options.signal,
    }),
    id: pluginTaskId(message),
    log: createPluginLogger(pluginName),
    model: createPluginModel(pluginName, plugin.model, {
      signal: options.signal,
    }),
    name: message.name,
    plugin: { name: pluginName },
    run: {
      async load() {
        return await loadPluginRun(sessionParams);
      },
    },
    state: createPluginState(pluginName),
  };
}

function findPluginTask(message: PluginTaskQueueMessage) {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === message.plugin,
  );
  if (!plugin?.tasks || !Object.hasOwn(plugin.tasks, message.name)) {
    return undefined;
  }
  const task = plugin.tasks[message.name];
  return { plugin, task };
}

/** Schedule all plugin tasks interested in a completed agent-run session. */
export async function scheduleSessionCompletedPluginTasks(
  params: PluginTaskParams,
  options: ScheduleSessionCompletedPluginTasksOptions = {},
): Promise<void> {
  const coreParams = pluginTaskParamsSchema.parse(params);
  const taskRegistrations = getPlugins().flatMap((plugin) =>
    Object.keys(plugin.tasks ?? {}).map((name) => ({ name, plugin })),
  );
  if (taskRegistrations.length === 0) {
    return;
  }
  const record = await getAgentTurnSessionRecord(
    coreParams.conversationId,
    coreParams.sessionId,
  );
  if (!record || record.state !== "completed") {
    throw new Error("Completed plugin task session record is not ready");
  }
  const send = options.send ?? sendVercelPluginTask;
  const messages = taskRegistrations.map(({ name, plugin }) => ({
    name,
    params: coreParams,
    plugin: plugin.manifest.name,
  }));
  await Promise.all(
    messages.map(async (message) => {
      await send(message);
    }),
  );
}

/** Execute one parsed plugin task request. */
export async function processPluginTask(
  message: PluginTaskQueueMessage,
  options: ProcessPluginTaskOptions = {},
): Promise<void> {
  await withPluginTaskLock(pluginTaskId(message), async () => {
    const resolved = findPluginTask(message);
    if (!resolved) {
      throw new Error(
        `Plugin task "${message.plugin}.${message.name}" is not registered`,
      );
    }
    await resolved.task.run(
      taskPluginContext(resolved.plugin, message, options),
    );
  });
}
