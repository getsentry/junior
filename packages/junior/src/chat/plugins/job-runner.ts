/**
 * Plugin background-job orchestration.
 *
 * Core schedules jobs from completed sessions and exposes plugins only a
 * bounded run projection rather than live runtime internals or queue
 * payloads.
 */
import type {
  Actor,
  PluginRegistration,
  PluginRunContext,
  PluginRunTranscriptEntry,
  PluginRunTranscriptProvenance,
  PluginJobContext,
} from "@sentry/junior-plugin-api";
import { pluginRunContextSchema } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginConversationEvents } from "@/chat/plugins/conversation-events";
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
import { resolveTurnSessionRouting } from "@/chat/services/turn-session-routing";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import type { ConversationMessage } from "@/chat/state/conversation";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
import {
  sameActorIdentity,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import {
  getTurnRecord,
  type TurnRecord,
} from "@/chat/task-execution/checkpoint";
import { getPlugins } from "./agent-hooks";
import {
  pluginJobId,
  pluginJobParamsSchema,
  type PluginJobParams,
  type PluginJobMessage,
} from "./job-message";
import { sendPluginJob } from "./job-delivery";
import { getStateAdapter } from "@/chat/state/adapter";
import type { Lock } from "chat";

const PLUGIN_JOB_LOCK_TTL_MS = 5 * 60 * 1000;

export interface ScheduleSessionCompletedPluginJobsOptions {
  send?: (message: PluginJobMessage) => Promise<void>;
}

interface ProcessPluginJobOptions {
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

/** Build the transcript provenance for a user message from its Pi provenance. */
function messageProvenance(
  provenance: ConversationMessageProvenance,
): PluginRunTranscriptProvenance {
  return {
    authority: provenance.authority,
    ...(provenance.actor ? { actor: provenance.actor } : {}),
  };
}

function runTranscriptEntry(
  message: PiMessage,
  provenance: ConversationMessageProvenance,
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
  record: TurnRecord,
): Array<{ message: PiMessage; provenance: ConversationMessageProvenance }> {
  const startIndex = record.turnStartMessageIndex ?? 0;
  const messages = record.piMessages.slice(startIndex);
  const provenance = record.piMessageProvenance.slice(startIndex);
  const paired: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
  }> = [];
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
  record: TurnRecord,
  source: PluginRunContext["source"],
  runActor: Actor | undefined,
): Promise<PluginRunTranscriptEntry[]> {
  // Prior conversation evidence is a Slack public-channel concern only.
  switch (source.platform) {
    case "slack":
      if (source.visibility === "private") {
        return [];
      }
      break;
    case "web":
    case "local":
      return [];
  }
  const state = await getPersistedThreadState(record.conversationId);
  const conversation = coerceThreadConversationState(state);
  await hydrateConversationMessages({
    conversation,
    conversationId: record.conversationId,
  });
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
      isRunActor: sameActorIdentity(author, runActor),
    });
  }
  return entries;
}

async function withPluginJobLock<T>(
  taskId: string,
  callback: () => Promise<T>,
): Promise<T> {
  const state = getStateAdapter();
  await state.connect();
  const lock: Lock | null = await state.acquireLock(
    `plugin:job:${taskId}`,
    PLUGIN_JOB_LOCK_TTL_MS,
  );
  if (!lock) {
    throw new Error(`Could not acquire plugin job lock for ${taskId}`);
  }

  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

/** Load the bounded completed-run projection exposed to plugin jobs. */
async function loadPluginRun(
  params: PluginJobParams,
): Promise<PluginRunContext> {
  const record = await getTurnRecord(params.conversationId, params.sessionId);
  if (!record) {
    throw new Error("Completed plugin job session record is unavailable");
  }
  if (record.state !== "completed") {
    throw new Error("Completed plugin job session record is not completed");
  }
  const routing = await resolveTurnSessionRouting({
    conversationId: params.conversationId,
  });
  // Singular run.actor comes from committed instruction provenance, or the
  // dispatch record for system-only runs. Optional only for legacy actor-less
  // records (plugins must fail closed on authority-sensitive work).
  const runActor =
    record.actors[0] ??
    (record.dispatchId
      ? (await getDispatchRecord(record.dispatchId))?.actor
      : undefined);
  const runEntries = turnMessagesWithProvenance(record)
    .map(({ message, provenance }) =>
      runTranscriptEntry(message, provenance, runActor),
    )
    .filter((entry): entry is PluginRunTranscriptEntry => Boolean(entry));
  const runMessageTexts = new Set(
    runEntries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.text),
  );
  const contextEntries = (
    await loadConversationContextTranscriptEntries(
      record,
      routing.source,
      runActor,
    )
  ).filter(
    (entry) => entry.type !== "message" || !runMessageTexts.has(entry.text),
  );
  return pluginRunContextSchema.parse({
    completedAtMs: record.updatedAtMs,
    conversationId: record.conversationId,
    destination: routing.destination,
    // Derived from the full run provenance on the record, not the sliced or
    // stripped transcript, so it reflects every committed instruction actor.
    actors: record.actors,
    ...(runActor ? { actor: runActor } : {}),
    runId: record.turnId,
    source: routing.source,
    transcript: [...contextEntries, ...runEntries],
  });
}

/** Build the plugin-facing context for one claimed job attempt. */
function jobPluginContext(
  plugin: PluginRegistration,
  message: PluginJobMessage,
  options: ProcessPluginJobOptions = {},
): PluginJobContext {
  const pluginName = plugin.manifest.name;
  const sessionParams = pluginJobParamsSchema.parse(message.params);
  return {
    db: getDb(),
    embedder: createPluginEmbedder(pluginName, {
      signal: options.signal,
    }),
    events: createPluginConversationEvents({
      conversationId: sessionParams.conversationId,
      operationId: pluginJobId(message),
      plugin,
      turnId: sessionParams.sessionId,
    }),
    id: pluginJobId(message),
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

function findPluginJob(message: PluginJobMessage) {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === message.plugin,
  );
  if (!plugin?.jobs || !Object.hasOwn(plugin.jobs, message.name)) {
    return undefined;
  }
  const job = plugin.jobs[message.name];
  return { plugin, job };
}

/** Schedule all plugin jobs interested in a completed agent-run session. */
export async function scheduleSessionCompletedPluginJobs(
  params: PluginJobParams,
  options: ScheduleSessionCompletedPluginJobsOptions = {},
): Promise<void> {
  const coreParams = pluginJobParamsSchema.parse(params);
  const jobRegistrations = getPlugins().flatMap((plugin) =>
    Object.keys(plugin.jobs ?? {}).map((name) => ({ name, plugin })),
  );
  if (jobRegistrations.length === 0) {
    return;
  }
  const record = await getTurnRecord(
    coreParams.conversationId,
    coreParams.sessionId,
  );
  if (!record || record.state !== "completed") {
    throw new Error("Completed plugin job session record is not ready");
  }
  const send = options.send ?? sendPluginJob;
  const messages = jobRegistrations.map(({ name, plugin }) => ({
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

/** Execute one parsed plugin job request. */
export async function runPluginJob(
  message: PluginJobMessage,
  options: ProcessPluginJobOptions = {},
): Promise<void> {
  await withPluginJobLock(pluginJobId(message), async () => {
    const resolved = findPluginJob(message);
    if (!resolved) {
      throw new Error(
        `Plugin job "${message.plugin}.${message.name}" is not registered`,
      );
    }
    await resolved.job.run(
      jobPluginContext(resolved.plugin, message, options),
    );
  });
}
