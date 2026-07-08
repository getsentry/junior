/**
 * Plugin background-task orchestration.
 *
 * Core schedules tasks from completed sessions and exposes plugins only a
 * bounded run projection rather than live runtime internals or queue
 * payloads.
 */
import type {
  Actor,
  PluginRegistration,
  PluginRunContext,
  PluginRunTranscriptEntry,
  PluginRunTranscriptProvenance,
  PluginTaskContext,
} from "@sentry/junior-plugin-api";
import {
  isPrivateSource,
  pluginRunContextSchema,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginEmbedder, createPluginModel } from "@/chat/plugins/model";
import { createPluginState } from "@/chat/plugins/state";
import type { PiMessage } from "@/chat/pi/messages";
import {
  getPiMessageRole,
  instructionTextForProjection,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import type { ConversationMessage } from "@/chat/state/conversation";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import type { PiMessageProvenance } from "@/chat/state/session-log";
import {
  getAgentTurnSessionRecord,
  type AgentTurnSessionRecord,
} from "@/chat/state/turn-session";
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

/** Compare two actors by runtime identity only, never by display name. */
function sameActorIdentity(
  left: Actor | undefined,
  right: Actor | undefined,
): boolean {
  if (!left || !right || left.platform !== right.platform) {
    return false;
  }
  if (left.platform === "system" || right.platform === "system") {
    return (
      left.platform === "system" &&
      right.platform === "system" &&
      left.name === right.name
    );
  }
  if (left.platform === "slack" && right.platform === "slack") {
    return left.teamId === right.teamId && left.userId === right.userId;
  }
  return left.userId === right.userId;
}

/** Build the transcript provenance for a user message from its Pi provenance. */
function messageProvenance(
  provenance: PiMessageProvenance,
): PluginRunTranscriptProvenance {
  return {
    authority: provenance.authority,
    ...(provenance.actor ? { actor: provenance.actor } : {}),
  };
}

function runTranscriptEntry(
  message: PiMessage,
  provenance: PiMessageProvenance,
  runActor: Actor | undefined,
): PluginRunTranscriptEntry | undefined {
  const role = getPiMessageRole(message);
  if (role === "user" || role === "assistant") {
    // User entries are instruction-authority evidence, so they must expose only
    // this turn's actual instruction — never the prior-thread context blocks the
    // runtime embeds alongside it, which carry other participants' verbatim text.
    const text =
      role === "user"
        ? instructionTextForProjection(messageText(message))
        : messageText(message);
    if (!text) {
      return undefined;
    }
    if (role === "assistant") {
      return { type: "message", role, text };
    }
    return {
      type: "message",
      role,
      text,
      provenance: messageProvenance(provenance),
      isRunActor: sameActorIdentity(provenance.actor, runActor),
    };
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

/**
 * Slice the current turn's Pi messages with their aligned provenance and strip
 * runtime turn context, keeping each surviving message paired with the exact
 * provenance recorded for it. Stripping can drop or rewrite messages, so the
 * pairing is applied per message rather than by post-strip index.
 */
function turnMessagesWithProvenance(
  record: AgentTurnSessionRecord,
): Array<{ message: PiMessage; provenance: PiMessageProvenance }> {
  const startIndex = record.turnStartMessageIndex ?? 0;
  const messages = record.piMessages.slice(startIndex);
  const provenance = record.piMessageProvenance.slice(startIndex);
  const paired: Array<{ message: PiMessage; provenance: PiMessageProvenance }> =
    [];
  for (const [index, message] of messages.entries()) {
    for (const stripped of stripRuntimeTurnContext([message])) {
      paired.push({
        message: stripped,
        provenance: provenance[index] ?? { authority: "context" },
      });
    }
  }
  return paired;
}

/** Recover the Slack context author identity from a persisted thread message. */
function slackContextAuthor(
  source: { teamId: string },
  message: ConversationMessage,
): Actor | undefined {
  const userId = message.author?.userId?.trim();
  if (!userId) {
    return undefined;
  }
  return {
    platform: "slack",
    teamId: source.teamId,
    userId,
    ...(message.author?.userName ? { userName: message.author.userName } : {}),
    ...(message.author?.fullName ? { fullName: message.author.fullName } : {}),
  };
}

function slackTimestampMs(value: unknown): number | undefined {
  const timestamp = parseSlackMessageTs(value);
  if (!timestamp) {
    return undefined;
  }
  const timestampMs = Number(timestamp) * 1000;
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function conversationMessageTimestampMs(
  message: ConversationMessage,
): number | undefined {
  if (message.meta?.slackTs !== undefined) {
    return slackTimestampMs(message.meta.slackTs);
  }
  return Number.isFinite(message.createdAtMs) ? message.createdAtMs : undefined;
}

function messageExistedAtRunCompletion(
  message: ConversationMessage,
  completedAtMs: number,
): boolean {
  const messageTimestampMs = conversationMessageTimestampMs(message);
  return (
    messageTimestampMs !== undefined && messageTimestampMs <= completedAtMs
  );
}

/**
 * Project bounded public-thread context into the run transcript.
 *
 * Prior public Slack messages are durable conversation evidence a completed run
 * may have acted on, so passive consumers can cite them. They are always
 * context authority (never instruction), and only public Slack sources
 * contribute; private and local sources add nothing here.
 */
async function loadConversationContextTranscriptEntries(
  record: AgentTurnSessionRecord,
): Promise<PluginRunTranscriptEntry[]> {
  const source = record.source;
  if (source?.platform !== "slack" || isPrivateSource(source)) {
    return [];
  }
  const state = await getPersistedThreadState(record.conversationId);
  const conversation = coerceThreadConversationState(state);
  const entries: PluginRunTranscriptEntry[] = [];
  for (const message of conversation.messages) {
    if (message.role !== "user") {
      continue;
    }
    if (!messageExistedAtRunCompletion(message, record.updatedAtMs)) {
      continue;
    }
    const text = sanitizeText(message.text);
    if (!text) {
      continue;
    }
    const author = slackContextAuthor(source, message);
    entries.push({
      type: "message",
      role: "user",
      text,
      provenance: {
        authority: "context",
        ...(author ? { actor: author } : {}),
      },
      isRunActor: sameActorIdentity(author, record.actor),
    });
  }
  return entries;
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
  const runEntries = turnMessagesWithProvenance(record)
    .map(({ message, provenance }) =>
      runTranscriptEntry(message, provenance, record.actor),
    )
    .filter((entry): entry is PluginRunTranscriptEntry => Boolean(entry));
  const runMessageTexts = new Set(
    runEntries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.text),
  );
  const contextEntries = (
    await loadConversationContextTranscriptEntries(record)
  ).filter(
    (entry) => entry.type !== "message" || !runMessageTexts.has(entry.text),
  );
  return pluginRunContextSchema.parse({
    completedAtMs: record.updatedAtMs,
    conversationId: record.conversationId,
    destination: record.destination,
    // Derived from the full run provenance on the record, not the sliced or
    // stripped transcript, so it reflects every committed instruction actor.
    actors: record.actors,
    ...(record.actor ? { actor: record.actor } : {}),
    runId: record.sessionId,
    source: record.source,
    transcript: [...contextEntries, ...runEntries],
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
