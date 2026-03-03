import { Chat, ThreadImpl } from "chat";
import type { Attachment, Message, SentMessage, Thread } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { z } from "zod";
import "@/chat/chat-background-patch";
import {
  createAppSlackRuntime,
  type AppRuntimeAssistantLifecycleEvent
} from "@/chat/app-runtime";
import { botConfig } from "@/chat/config";
import { buildConversationStatePatch, coerceThreadConversationState } from "@/chat/conversation-state";
import type {
  ConversationCompaction,
  ConversationMessage,
  ThreadConversationState
} from "@/chat/conversation-state";
import { logException, logInfo, logWarn, setTags, toOptionalString, withSpan } from "@/chat/observability";
import { escapeXml } from "@/chat/xml";
import { buildSlackOutputMessage, ensureBlockSpacing } from "@/chat/output";
import { generateAssistantReply as generateAssistantReplyImpl } from "@/chat/respond";
import {
  buildArtifactStatePatch,
  coerceThreadArtifactsState,
  type ThreadArtifactsState
} from "@/chat/slack-actions/types";
import { parseSlackThreadId, resolveSlackChannelIdFromMessage } from "@/chat/slack-context";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { ChannelConfigurationService } from "@/chat/configuration/types";
import { truncateStatusText } from "@/chat/status-format";
import { handleSlashCommand } from "@/chat/slash-command";
import { lookupSlackUser } from "@/chat/slack-user";
import { getStateAdapter } from "@/chat/state";
import { completeObject, completeText, GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { listThreadReplies } from "@/chat/slack-actions/channel";
import { downloadPrivateSlackFile, getSlackClient } from "@/chat/slack-actions/client";
import { publishAppHomeView } from "@/chat/app-home";
import { getUserTokenStore } from "@/chat/capabilities/factory";

interface BotDeps {
  completeObject: typeof completeObject;
  completeText: typeof completeText;
  downloadPrivateSlackFile: typeof downloadPrivateSlackFile;
  generateAssistantReply: typeof generateAssistantReplyImpl;
  listThreadReplies: typeof listThreadReplies;
  lookupSlackUser: typeof lookupSlackUser;
}

const defaultBotDeps: BotDeps = {
  completeObject,
  completeText,
  downloadPrivateSlackFile,
  generateAssistantReply: generateAssistantReplyImpl,
  listThreadReplies,
  lookupSlackUser
};

let botDeps: BotDeps = defaultBotDeps;

export function setBotDepsForTests(overrides: Partial<BotDeps>): void {
  botDeps = {
    ...defaultBotDeps,
    ...overrides
  };
}

export function resetBotDepsForTests(): void {
  botDeps = defaultBotDeps;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingBotMention(
  text: string,
  options: {
    stripLeadingSlackMentionToken?: boolean;
  } = {}
): string {
  if (!text.trim()) return text;

  let next = text;
  if (options.stripLeadingSlackMentionToken) {
    next = next.replace(/^\s*<@[^>]+>[\s,:-]*/, "").trim();
  }

  const mentionByNameRe = new RegExp(`^\\s*@${escapeRegExp(botConfig.userName)}\\b[\\s,:-]*`, "i");
  next = next.replace(mentionByNameRe, "").trim();

  const mentionByLabeledEntityRe = new RegExp(
    `^\\s*<@[^>|]+\\|${escapeRegExp(botConfig.userName)}>[\\s,:-]*`,
    "i"
  );
  next = next.replace(mentionByLabeledEntityRe, "").trim();

  return next;
}

function getThreadId(thread: Thread, _message: Message): string | undefined {
  return toOptionalString(thread.id);
}

function getWorkflowRunId(thread: Thread, message: Message): string | undefined {
  return (
    toOptionalString((thread as unknown as { runId?: unknown }).runId) ??
    toOptionalString((message as unknown as { runId?: unknown }).runId)
  );
}

function getChannelId(thread: Thread, message: Message): string | undefined {
  return thread.channelId ?? resolveSlackChannelIdFromMessage(message);
}

function getThreadTs(threadId: string | undefined): string | undefined {
  return parseSlackThreadId(threadId)?.threadTs;
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack");
}

const STATUS_UPDATE_DEBOUNCE_MS = 1000;

function createProgressReporter(thread: Pick<Thread, "startTyping">) {
  let active = false;
  let currentStatus = "";
  let lastStatusAt = 0;
  let pendingStatus: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;


  const postStatus = async (text: string): Promise<void> => {
    currentStatus = text;
    lastStatusAt = Date.now();
    try {
      await thread.startTyping(text);
    } catch {
      // Best effort only.
    }
  };

  const clearPending = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingStatus = null;
  };

  const flushPending = async () => {
    if (!active || !pendingStatus) {
      clearPending();
      return;
    }

    const next = pendingStatus;
    clearPending();
    if (next !== currentStatus) {
      await postStatus(next);
    }
  };

  return {
    async start() {
      active = true;
      clearPending();
      await postStatus("Thinking...");
    },
    async stop() {
      active = false;
      clearPending();
      try {
        await thread.startTyping("");
      } catch {
        // Best effort only.
      }
    },
    async setStatus(text: string) {
      const truncated = truncateStatusText(text);
      if (!active || !truncated || truncated === currentStatus) {
        return;
      }

      const now = Date.now();
      const elapsed = now - lastStatusAt;
      if (elapsed >= STATUS_UPDATE_DEBOUNCE_MS) {
        clearPending();
        await postStatus(truncated);
        return;
      }

      pendingStatus = truncated;
      if (pendingTimer) {
        return;
      }

      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        void flushPending();
      }, Math.max(1, STATUS_UPDATE_DEBOUNCE_MS - elapsed));
    }
  };
}

function createTextStreamBridge() {
  const queue: string[] = [];
  let ended = false;
  let wakeConsumer: (() => void) | null = null;

  const iterable: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      while (!ended || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
      }
    }
  };

  return {
    iterable,
    push(delta: string) {
      if (!delta || ended) {
        return;
      }
      queue.push(delta);
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      const wake = wakeConsumer;
      wakeConsumer = null;
      wake?.();
    }
  };
}


export function createNormalizingStream(
  inner: AsyncIterable<string>,
  normalize: (text: string) => string
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      let accumulated = "";
      let emitted = 0;
      for await (const chunk of inner) {
        accumulated += chunk;
        const lastNewline = accumulated.lastIndexOf("\n");

        if (lastNewline === -1) {
          // No newline yet — yield raw (identical to normalized for single-line content)
          const delta = accumulated.slice(emitted);
          if (delta) {
            yield delta;
            emitted = accumulated.length;
          }
          continue;
        }

        // Normalize up to the last complete line to avoid corruption
        // when a partial line changes meaning as more characters arrive
        const stable = accumulated.slice(0, lastNewline + 1);
        const normalized = normalize(stable);
        const delta = normalized.slice(emitted);
        emitted = normalized.length;
        if (delta) yield delta;
      }
      // Flush remaining text (final incomplete line)
      if (accumulated) {
        const normalized = normalize(accumulated);
        const delta = normalized.slice(emitted);
        if (delta) yield delta;
      }
    }
  };
}

interface UserInputAttachment {
  data: Buffer;
  mediaType: string;
  filename?: string;
}

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
const MAX_VISION_SUMMARY_CHARS = 500;

async function resolveUserAttachments(
  attachments: Attachment[] | undefined,
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  }
): Promise<UserInputAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  const results: UserInputAttachment[] = [];
  for (const attachment of attachments) {
    if (results.length >= MAX_USER_ATTACHMENTS) break;
    if (attachment.type !== "image" && attachment.type !== "file") continue;

    const mediaType = attachment.mimeType ?? "application/octet-stream";

    try {
      let data: Buffer | null = null;

      if (attachment.fetchData) {
        data = await attachment.fetchData();
      } else if (attachment.data instanceof Buffer) {
        data = attachment.data;
      }

      if (!data) continue;
      if (data.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "attachment_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.size": data.byteLength,
            "file.mime_type": mediaType
          },
          "Skipping user attachment that exceeds size limit"
        );
        continue;
      }

      results.push({
        data,
        mediaType,
        filename: attachment.name
      });
    } catch (error) {
      logWarn(
        "attachment_resolution_failed",
        {
          slackThreadId: context.threadId,
          slackUserId: context.requesterId,
          slackChannelId: context.channelId,
          workflowRunId: context.workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId
        },
        {
          "error.message": error instanceof Error ? error.message : String(error),
          "file.mime_type": mediaType
        },
        "Failed to resolve user attachment"
      );
    }
  }

  return results;
}

const CONTEXT_COMPACTION_TRIGGER_TOKENS = 9000;
const CONTEXT_COMPACTION_TARGET_TOKENS = 7000;
const CONTEXT_MIN_LIVE_MESSAGES = 12;
const CONTEXT_COMPACTION_BATCH_SIZE = 24;
const CONTEXT_MAX_COMPACTIONS = 16;
const CONTEXT_MAX_MESSAGE_CHARS = 3200;
const BACKFILL_MESSAGE_LIMIT = 80;

function generateConversationId(prefix: "assistant" | "backfill" | "compaction" | "turn"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConversationText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, CONTEXT_MAX_MESSAGE_CHARS);
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildImageContextSuffix(
  message: ConversationMessage,
  conversation: ThreadConversationState | undefined
): string {
  const byFileId = conversation?.vision.byFileId;
  const imageFileIds = message.meta?.imageFileIds ?? [];
  if (!byFileId || imageFileIds.length === 0) {
    return "";
  }

  const summaries = imageFileIds
    .map((fileId) => byFileId[fileId]?.summary?.trim())
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length === 0) {
    return "";
  }

  return ` [image context: ${summaries.join(" | ")}]`;
}

function renderConversationMessageLine(
  message: ConversationMessage,
  conversation?: ThreadConversationState
): string {
  const displayName =
    message.author?.fullName ||
    message.author?.userName ||
    (message.role === "assistant" ? botConfig.userName : message.role);

  const markers: string[] = [];
  if (message.meta?.replied === false) {
    markers.push(`assistant skipped: ${message.meta?.skippedReason ?? "no-reply route"}`);
  }
  if (message.meta?.explicitMention) {
    markers.push("explicit mention");
  }

  const markerSuffix = markers.length > 0 ? ` (${markers.join("; ")})` : "";
  const imageContext = buildImageContextSuffix(message, conversation);
  return `[${message.role}] ${displayName}: ${message.text}${imageContext}${markerSuffix}`;
}

function updateConversationStats(conversation: ThreadConversationState): void {
  const contextText = buildConversationContext(conversation);
  conversation.stats.estimatedContextTokens = estimateTokenCount(contextText ?? "");
  conversation.stats.totalMessageCount = conversation.messages.length;
  conversation.stats.updatedAtMs = Date.now();
}

function upsertConversationMessage(conversation: ThreadConversationState, message: ConversationMessage): string {
  const existingIndex = conversation.messages.findIndex((entry) => entry.id === message.id);
  if (existingIndex >= 0) {
    conversation.messages[existingIndex] = {
      ...conversation.messages[existingIndex],
      ...message,
      meta: {
        ...conversation.messages[existingIndex]?.meta,
        ...message.meta
      }
    };
    updateConversationStats(conversation);
    return message.id;
  }

  conversation.messages.push(message);
  updateConversationStats(conversation);
  return message.id;
}

function markConversationMessage(
  conversation: ThreadConversationState,
  messageId: string | undefined,
  patch: Partial<NonNullable<ConversationMessage["meta"]>>
): void {
  if (!messageId) return;

  const messageIndex = conversation.messages.findIndex((entry) => entry.id === messageId);
  if (messageIndex < 0) return;

  const current = conversation.messages[messageIndex];
  conversation.messages[messageIndex] = {
    ...current,
    meta: {
      ...(current.meta ?? {}),
      ...patch
    }
  };
  updateConversationStats(conversation);
}

function buildConversationContext(
  conversation: ThreadConversationState,
  options: {
    excludeMessageId?: string;
  } = {}
): string | undefined {
  const messages = conversation.messages.filter((entry) => entry.id !== options.excludeMessageId);
  if (messages.length === 0 && conversation.compactions.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  if (conversation.compactions.length > 0) {
    lines.push("<thread-compactions>");
    for (const [index, compaction] of conversation.compactions.entries()) {
      lines.push(
        [
          `summary_${index + 1}:`,
          compaction.summary,
          `covered_messages: ${compaction.coveredMessageIds.length}`,
          `created_at: ${new Date(compaction.createdAtMs).toISOString()}`
        ].join(" ")
      );
    }
    lines.push("</thread-compactions>");
    lines.push("");
  }

  lines.push("<thread-transcript>");
  for (const message of messages) {
    lines.push(renderConversationMessageLine(message, conversation));
  }
  lines.push("</thread-transcript>");
  return lines.join("\n");
}

function pruneCompactions(compactions: ConversationCompaction[]): ConversationCompaction[] {
  if (compactions.length <= CONTEXT_MAX_COMPACTIONS) {
    return compactions;
  }

  const overflowCount = compactions.length - CONTEXT_MAX_COMPACTIONS + 1;
  const merged = compactions.slice(0, overflowCount);
  const mergedSummary = merged.map((entry) => entry.summary).join("\n").slice(0, 3500);
  const mergedIds = merged.flatMap((entry) => entry.coveredMessageIds).slice(0, 500);

  const compacted: ConversationCompaction = {
    id: generateConversationId("compaction"),
    createdAtMs: Date.now(),
    summary: mergedSummary,
    coveredMessageIds: mergedIds
  };
  return [compacted, ...compactions.slice(overflowCount)];
}

async function summarizeConversationChunk(
  messages: ConversationMessage[],
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    workflowRunId?: string;
  }
): Promise<string> {
  const transcript = messages.map((message) => renderConversationMessageLine(message, conversation)).join("\n");

  try {
    const result = await botDeps.completeText({
      modelId: botConfig.routerModelId,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            "Summarize the following older Slack thread transcript segment for future assistant turns.",
            "Keep the summary factual and concise.",
            "Preserve decisions, commitments, constraints, locations, hiring criteria, and unresolved asks.",
            "Do not invent details.",
            "",
            transcript
          ].join("\n"),
          timestamp: Date.now()
        }
      ],
      metadata: {
        modelId: botConfig.routerModelId,
        threadId: context.threadId ?? "",
        channelId: context.channelId ?? "",
        requesterId: context.requesterId ?? "",
        workflowRunId: context.workflowRunId ?? ""
      }
    });
    const summary = result.text.trim();
    if (summary.length > 0) {
      return summary.slice(0, 3500);
    }
  } catch (error) {
    logWarn(
      "conversation_compaction_summary_failed",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.routerModelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "app.compaction_messages_covered": messages.length
      },
      "Compaction summarization failed; using fallback summary"
    );
  }

  return transcript.slice(0, 2800);
}

async function generateThreadTitle(userText: string, assistantText: string): Promise<string> {
  const result = await botDeps.completeText({
    modelId: botConfig.routerModelId,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "Generate a concise 5-8 word title for this conversation. Reply with ONLY the title, no quotes or punctuation.",
          "",
          `User: ${userText.slice(0, 500)}`,
          `Assistant: ${assistantText.slice(0, 500)}`
        ].join("\n"),
        timestamp: Date.now()
      }
    ]
  });
  return result.text.trim().slice(0, 60);
}

async function compactConversationIfNeeded(
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    workflowRunId?: string;
  }
): Promise<void> {
  updateConversationStats(conversation);
  let estimatedTokens = conversation.stats.estimatedContextTokens;
  logInfo(
    "conversation_context_estimated",
    {
      slackThreadId: context.threadId,
      slackUserId: context.requesterId,
      slackChannelId: context.channelId,
      workflowRunId: context.workflowRunId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    },
    {
      "app.context_tokens_estimated": estimatedTokens
    },
    "Estimated thread context tokens"
  );

  while (
    estimatedTokens > CONTEXT_COMPACTION_TRIGGER_TOKENS &&
    conversation.messages.length > CONTEXT_MIN_LIVE_MESSAGES
  ) {
    const compactCount = Math.min(
      CONTEXT_COMPACTION_BATCH_SIZE,
      conversation.messages.length - CONTEXT_MIN_LIVE_MESSAGES
    );
    if (compactCount <= 0) {
      break;
    }

    const compactedChunk = conversation.messages.slice(0, compactCount);
    const summary = await summarizeConversationChunk(compactedChunk, conversation, context);
    conversation.compactions.push({
      id: generateConversationId("compaction"),
      createdAtMs: Date.now(),
      summary,
      coveredMessageIds: compactedChunk.map((entry) => entry.id)
    });
    conversation.compactions = pruneCompactions(conversation.compactions);
    conversation.messages = conversation.messages.slice(compactCount);
    conversation.stats.compactedMessageCount += compactCount;
    updateConversationStats(conversation);

    estimatedTokens = conversation.stats.estimatedContextTokens;
    logInfo(
      "conversation_compaction_applied",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "app.compaction_messages_covered": compactCount,
        "app.context_tokens_estimated": estimatedTokens
      },
      "Compacted thread transcript context"
    );

    if (estimatedTokens <= CONTEXT_COMPACTION_TARGET_TOKENS) {
      break;
    }
  }
}

function createConversationMessageFromSdkMessage(
  entry: Message,
  _fallbackPrefix: "backfill" | "turn"
): ConversationMessage | null {
  const rawText = normalizeConversationText(entry.text);
  if (!rawText) {
    return null;
  }

  return {
    id: entry.id,
    role: entry.author.isMe ? "assistant" : "user",
    text: rawText,
    createdAtMs: entry.metadata.dateSent.getTime(),
    author: {
      userId: entry.author.userId,
      userName: entry.author.userName,
      fullName: entry.author.fullName,
      isBot: typeof entry.author.isBot === "boolean" ? entry.author.isBot : undefined
    },
    meta: {
      slackTs: entry.id
    }
  };
}

async function seedConversationBackfill(
  thread: Thread,
  conversation: ThreadConversationState
): Promise<void> {
  if (conversation.backfill.completedAtMs) {
    return;
  }
  if (conversation.messages.length > 0 || conversation.compactions.length > 0) {
    conversation.backfill = {
      completedAtMs: Date.now(),
      source: "recent_messages"
    };
    updateConversationStats(conversation);
    return;
  }

  const seeded: ConversationMessage[] = [];
  let source: "recent_messages" | "thread_fetch" = "recent_messages";

  try {
    const fetchedNewestFirst: Message[] = [];
    for await (const entry of thread.messages) {
      fetchedNewestFirst.push(entry);
      if (fetchedNewestFirst.length >= BACKFILL_MESSAGE_LIMIT) {
        break;
      }
    }
    fetchedNewestFirst.reverse();
    for (const entry of fetchedNewestFirst) {
      const message = createConversationMessageFromSdkMessage(entry, "backfill");
      if (message) {
        seeded.push(message);
      }
    }
    if (seeded.length > 0) {
      source = "thread_fetch";
    }
  } catch {
    // Fallback below.
  }

  if (seeded.length === 0) {
    try {
      await thread.refresh();
    } catch {
      // Best effort only.
    }

    const fromRecent = thread.recentMessages.slice(-BACKFILL_MESSAGE_LIMIT);
    for (const entry of fromRecent) {
      const message = createConversationMessageFromSdkMessage(entry, "backfill");
      if (message) {
        seeded.push(message);
      }
    }
    source = "recent_messages";
  }

  for (const message of seeded) {
    upsertConversationMessage(conversation, message);
  }

  conversation.backfill = {
    completedAtMs: Date.now(),
    source
  };
  updateConversationStats(conversation);
}

function isHumanConversationMessage(message: ConversationMessage): boolean {
  return message.role === "user" && message.author?.isBot !== true;
}

function getConversationMessageSlackTs(message: ConversationMessage): string | undefined {
  return message.meta?.slackTs ?? toOptionalString(message.id);
}

async function summarizeConversationImage(args: {
  imageData: Buffer;
  mimeType: string;
  fileId: string;
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    workflowRunId?: string;
  };
}): Promise<string | undefined> {
  try {
    const result = await botDeps.completeText({
      modelId: botConfig.modelId,
      temperature: 0,
      maxTokens: 220,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Extract concise, factual context from this image for future thread turns.",
                "Focus on visible text, names, titles, companies, and candidate-identifying details.",
                "Do not speculate.",
                "Return plain text only."
              ].join(" ")
            },
            {
              type: "image",
              data: args.imageData.toString("base64"),
              mimeType: args.mimeType
            }
          ],
          timestamp: Date.now()
        }
      ],
      metadata: {
        modelId: botConfig.modelId,
        threadId: args.context.threadId ?? "",
        channelId: args.context.channelId ?? "",
        requesterId: args.context.requesterId ?? "",
        workflowRunId: args.context.workflowRunId ?? "",
        fileId: args.fileId
      }
    });
    const summary = result.text.trim().replace(/\s+/g, " ");
    if (!summary) {
      return undefined;
    }
    return summary.slice(0, MAX_VISION_SUMMARY_CHARS);
  } catch (error) {
    logWarn(
      "conversation_image_vision_failed",
      {
        slackThreadId: args.context.threadId,
        slackUserId: args.context.requesterId,
        slackChannelId: args.context.channelId,
        workflowRunId: args.context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "file.id": args.fileId,
        "file.mime_type": args.mimeType
      },
      "Image analysis failed while hydrating conversation context"
    );
    return undefined;
  }
}

async function hydrateConversationVisionContext(
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    workflowRunId?: string;
    threadTs?: string;
  }
): Promise<void> {
  if (!context.channelId || !context.threadTs) {
    return;
  }

  const messagesByTs = new Map<string, ConversationMessage>();
  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) continue;
    if (message.meta?.imagesHydrated) continue;
    const slackTs = getConversationMessageSlackTs(message);
    if (!slackTs) continue;
    messagesByTs.set(slackTs, message);
  }
  if (messagesByTs.size === 0) {
    return;
  }

  let replies: Awaited<ReturnType<typeof listThreadReplies>>;
  try {
    replies = await botDeps.listThreadReplies({
      channelId: context.channelId,
      threadTs: context.threadTs,
      limit: 1000,
      maxPages: 10,
      targetMessageTs: [...messagesByTs.keys()]
    });
  } catch (error) {
    logWarn(
      "conversation_image_replies_fetch_failed",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to fetch thread replies for image context hydration"
    );
    return;
  }

  let cacheHits = 0;
  let cacheMisses = 0;
  let analyzed = 0;
  let mutated = false;
  const hydratedMessageIds = new Set<string>();

  for (const reply of replies) {
    const ts = toOptionalString(reply.ts);
    if (!ts || reply.bot_id || reply.subtype === "bot_message") {
      continue;
    }

    const conversationMessage = messagesByTs.get(ts);
    if (!conversationMessage) {
      continue;
    }
    hydratedMessageIds.add(conversationMessage.id);

    const imageFiles = (reply.files ?? [])
      .filter((file) => {
        const mimeType = toOptionalString(file.mimetype);
        return Boolean(toOptionalString(file.id) && mimeType?.startsWith("image/"));
      })
      .slice(0, MAX_MESSAGE_IMAGE_ATTACHMENTS);
    if (imageFiles.length === 0) {
      continue;
    }

    const imageFileIds = imageFiles
      .map((file) => toOptionalString(file.id))
      .filter((fileId): fileId is string => Boolean(fileId));
    const existingMeta = conversationMessage.meta ?? {};
    conversationMessage.meta = {
      ...existingMeta,
      slackTs: existingMeta.slackTs ?? ts,
      imageFileIds,
      imagesHydrated: true
    };
    mutated = true;

    for (const file of imageFiles) {
      const fileId = toOptionalString(file.id);
      if (!fileId) continue;

      if (conversation.vision.byFileId[fileId]) {
        cacheHits += 1;
        continue;
      }
      cacheMisses += 1;

      const mimeType = toOptionalString(file.mimetype) ?? "application/octet-stream";
      const fileSize = typeof file.size === "number" && Number.isFinite(file.size) ? file.size : undefined;
      if (fileSize && fileSize > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": fileSize,
            "file.mime_type": mimeType
          },
          "Skipping thread image that exceeds size limit"
        );
        continue;
      }

      const downloadUrl = toOptionalString(file.url_private_download) ?? toOptionalString(file.url_private);
      if (!downloadUrl) {
        continue;
      }

      let imageData: Buffer;
      try {
        imageData = await botDeps.downloadPrivateSlackFile(downloadUrl);
      } catch (error) {
        logWarn(
          "conversation_image_download_failed",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "error.message": error instanceof Error ? error.message : String(error),
            "file.id": fileId,
            "file.mime_type": mimeType
          },
          "Failed to download thread image for context hydration"
        );
        continue;
      }

      if (imageData.byteLength > MAX_USER_ATTACHMENT_BYTES) {
        logWarn(
          "conversation_image_skipped_size_limit",
          {
            slackThreadId: context.threadId,
            slackUserId: context.requesterId,
            slackChannelId: context.channelId,
            workflowRunId: context.workflowRunId,
            assistantUserName: botConfig.userName,
            modelId: botConfig.modelId
          },
          {
            "file.id": fileId,
            "file.size": imageData.byteLength,
            "file.mime_type": mimeType
          },
          "Skipping downloaded thread image that exceeds size limit"
        );
        continue;
      }

      const summary = await summarizeConversationImage({
        imageData,
        mimeType,
        fileId,
        context
      });
      if (!summary) {
        continue;
      }

      conversation.vision.byFileId[fileId] = {
        summary,
        analyzedAtMs: Date.now()
      };
      analyzed += 1;
      mutated = true;
    }
  }

  if (mutated) {
    updateConversationStats(conversation);
  }

  if (cacheHits > 0 || cacheMisses > 0 || analyzed > 0 || hydratedMessageIds.size > 0) {
    logInfo(
      "conversation_image_context_hydrated",
      {
        slackThreadId: context.threadId,
        slackUserId: context.requesterId,
        slackChannelId: context.channelId,
        workflowRunId: context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.modelId
      },
      {
        "app.conversation_image.cache_hits": cacheHits,
        "app.conversation_image.cache_misses": cacheMisses,
        "app.conversation_image.analyzed": analyzed,
        "app.conversation_image.messages_hydrated": hydratedMessageIds.size
      },
      "Hydrated conversation image context"
    );
  }

  if (!conversation.vision.backfillCompletedAtMs) {
    conversation.vision.backfillCompletedAtMs = Date.now();
  }
}

const replyDecisionSchema = z.object({
  should_reply: z.boolean().describe("Whether Junior should respond to this thread message."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Classifier confidence from 0 to 1."),
  reason: z
    .string()
    .max(160)
    .optional()
    .describe("Short reason for the decision.")
});

const ROUTER_CONFIDENCE_THRESHOLD = 0.72;

async function shouldReplyInSubscribedThread(args: {
  rawText: string;
  text: string;
  conversationContext?: string;
  hasAttachments?: boolean;
  isExplicitMention?: boolean;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  };
}): Promise<{ shouldReply: boolean; reason: string }> {
  const text = args.text.trim();
  const rawText = args.rawText.trim();

  if (args.isExplicitMention) {
    return { shouldReply: true, reason: "explicit mention" };
  }
  if (!text && !args.hasAttachments) {
    return { shouldReply: false, reason: "empty message" };
  }
  if (!text && args.hasAttachments) {
    return { shouldReply: true, reason: "attachment" };
  }

  try {
    const routerSystem = [
      "You are a message router for a Slack assistant named Junior in a subscribed Slack thread.",
      "Decide whether Junior should reply to the latest message.",
      "Default to should_reply=false unless the user is clearly asking Junior for help or follow-up.",
      "",
      "Reply should be true only when the user is clearly asking Junior a question, requesting help,",
      "or when a direct follow-up is contextually aimed at Junior's previous response in the thread context.",
      "",
      "Reply should be false for side conversations between humans, acknowledgements (thanks, +1),",
      "status chatter, or messages not seeking assistant input.",
      "Junior must not participate in casual banter.",
      "If uncertain, set should_reply=false and use low confidence.",
      "",
      "Return JSON with should_reply, confidence, and a short reason. Do not return any extra keys.",
      "",
      `<assistant-name>${escapeXml(botConfig.userName)}</assistant-name>`,
      `<thread-context>${escapeXml(args.conversationContext?.trim() || "[none]")}</thread-context>`
    ].join("\n");

    const result = await botDeps.completeObject({
      modelId: botConfig.routerModelId,
      schema: replyDecisionSchema,
      maxTokens: 120,
      temperature: 0,
      system: routerSystem,
      prompt: rawText,
      metadata: {
        modelId: botConfig.routerModelId,
        threadId: args.context.threadId ?? "",
        channelId: args.context.channelId ?? "",
        requesterId: args.context.requesterId ?? "",
        workflowRunId: args.context.workflowRunId ?? ""
      }
    });

    const parsed = replyDecisionSchema.parse(result.object);
    const reason = parsed.reason?.trim() || "llm classifier";
    if (!parsed.should_reply) {
      return {
        shouldReply: false,
        reason
      };
    }

    if (parsed.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
      return {
        shouldReply: false,
        reason: `low confidence (${parsed.confidence.toFixed(2)}): ${reason}`
      };
    }

    return {
      shouldReply: true,
      reason
    };
  } catch (error) {
    logWarn(
      "subscribed_reply_classifier_failed",
      {
        slackThreadId: args.context.threadId,
        slackUserId: args.context.requesterId,
        slackChannelId: args.context.channelId,
        workflowRunId: args.context.workflowRunId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.routerModelId
      },
      {
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Subscribed-thread reply classifier failed; skipping reply"
    );
    return {
      shouldReply: false,
      reason: "classifier error"
    };
  }
}

export const bot = new Chat<{ slack: SlackAdapter }>({
  userName: botConfig.userName,
  adapters: {
    slack: createSlackAdapter()
  },
  state: getStateAdapter()
});

interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  channelConfiguration?: ChannelConfigurationService;
  conversation: ThreadConversationState;
  conversationContext?: string;
  routingContext?: string;
  sandboxId?: string;
  userMessageId?: string;
}

function mergeArtifactsState(
  artifacts: ThreadArtifactsState,
  patch: Partial<ThreadArtifactsState> | undefined
): ThreadArtifactsState {
  if (!patch) {
    return artifacts;
  }

  return {
    ...artifacts,
    ...patch,
    listColumnMap: {
      ...artifacts.listColumnMap,
      ...patch.listColumnMap
    }
  };
}

async function persistThreadState(
  thread: Thread,
  patch: {
    artifacts?: ThreadArtifactsState;
    conversation?: ThreadConversationState;
    sandboxId?: string;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (patch.artifacts) {
    Object.assign(payload, buildArtifactStatePatch(patch.artifacts));
  }
  if (patch.conversation) {
    Object.assign(payload, buildConversationStatePatch(patch.conversation));
  }
  if (patch.sandboxId) {
    payload.app_sandbox_id = patch.sandboxId;
  }

  if (Object.keys(payload).length === 0) {
    return;
  }
  await thread.setState(payload);
}

function getChannelConfigurationService(thread: Thread): ChannelConfigurationService {
  const channel = thread.channel;
  return createChannelConfigurationService({
    load: async () => channel.state,
    save: async (state) => {
      await channel.setState({
        configuration: state
      });
    }
  });
}

async function prepareTurnState(args: {
  explicitMention: boolean;
  message: Message;
  thread: Thread;
  userText: string;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  };
}): Promise<PreparedTurnState> {
  const existingState = await args.thread.state;
  const existingSandboxId = existingState
    ? toOptionalString((existingState as Record<string, unknown>).app_sandbox_id)
    : undefined;
  const artifacts = coerceThreadArtifactsState(existingState);
  const conversation = coerceThreadConversationState(existingState);
  const channelConfiguration = getChannelConfigurationService(args.thread);
  const configuration = await channelConfiguration.resolveValues();

  await seedConversationBackfill(args.thread, conversation);
  const messageHasPotentialImageAttachment = args.message.attachments.some((attachment) => {
    if (attachment.type === "image") {
      return true;
    }
    const mimeType = attachment.mimeType ?? "";
    return attachment.type === "file" && mimeType.startsWith("image/");
  });

  const normalizedUserText = normalizeConversationText(args.userText) || "[non-text message]";
  const incomingUserMessage: ConversationMessage = {
    id: args.message.id,
    role: "user",
    text: normalizedUserText,
    createdAtMs: args.message.metadata.dateSent.getTime(),
    author: {
      userId: args.message.author.userId,
      userName: args.message.author.userName,
      fullName: args.message.author.fullName,
      isBot: typeof args.message.author.isBot === "boolean" ? args.message.author.isBot : undefined
    },
    meta: {
      explicitMention: args.explicitMention,
      slackTs: args.message.id,
      imagesHydrated: !messageHasPotentialImageAttachment
    }
  };

  const userMessageId = upsertConversationMessage(conversation, incomingUserMessage);

  if (messageHasPotentialImageAttachment || !conversation.vision.backfillCompletedAtMs) {
    await hydrateConversationVisionContext(conversation, {
      threadId: args.context.threadId,
      channelId: args.context.channelId,
      requesterId: args.context.requesterId,
      workflowRunId: args.context.workflowRunId,
      threadTs: getThreadTs(args.context.threadId)
    });
  }

  await compactConversationIfNeeded(conversation, {
    threadId: args.context.threadId,
    channelId: args.context.channelId,
    requesterId: args.context.requesterId,
    workflowRunId: args.context.workflowRunId
  });

  const conversationContext = buildConversationContext(conversation);
  const routingContext = buildConversationContext(conversation, {
    excludeMessageId: userMessageId
  });

  logInfo(
    "conversation_turn_prepared",
    {
      slackThreadId: args.context.threadId,
      slackUserId: args.context.requesterId,
      slackChannelId: args.context.channelId,
      workflowRunId: args.context.workflowRunId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    },
    {
      "app.backfill_source": conversation.backfill.source ?? "none",
      "app.context_tokens_estimated": conversation.stats.estimatedContextTokens
    },
    "Prepared thread conversation state"
  );

  return {
    artifacts,
    configuration,
    channelConfiguration,
    conversation,
    sandboxId: existingSandboxId,
    conversationContext,
    routingContext,
    userMessageId
  };
}

async function replyToThread(
  thread: Thread,
  message: Message,
  options: {
    explicitMention?: boolean;
    preparedState?: PreparedTurnState;
  } = {}
) {
  if (message.author.isMe) {
    return;
  }

  const threadId = getThreadId(thread, message);
  const channelId = getChannelId(thread, message);
  const threadTs = getThreadTs(threadId);
  const workflowRunId = getWorkflowRunId(thread, message);

  await withSpan(
    "workflow.reply",
    "workflow.reply",
    {
      slackThreadId: threadId,
      slackUserId: message.author.userId,
      slackChannelId: channelId,
      workflowRunId,
      assistantUserName: botConfig.userName,
      modelId: botConfig.modelId
    },
    async () => {
      const userText = stripLeadingBotMention(message.text, {
        stripLeadingSlackMentionToken: options.explicitMention || Boolean(message.isMention)
      });

      const preparedState =
        options.preparedState ??
        (await prepareTurnState({
          thread,
          message,
          userText,
          explicitMention: Boolean(options.explicitMention || message.isMention),
          context: {
            threadId,
            requesterId: message.author.userId,
            channelId,
            workflowRunId
          }
        }));

      preparedState.conversation.processing.activeTurnId = generateConversationId("turn");
      updateConversationStats(preparedState.conversation);
      await persistThreadState(thread, {
        conversation: preparedState.conversation
      });

      const fallbackIdentity = await botDeps.lookupSlackUser(message.author.userId);
      const resolvedUserName = message.author.userName ?? fallbackIdentity?.userName;
      if (resolvedUserName) {
        setTags({ slackUserName: resolvedUserName });
      }
      const userAttachments = await resolveUserAttachments(message.attachments, {
        threadId,
        requesterId: message.author.userId,
        channelId,
        workflowRunId
      });

      const progress = createProgressReporter(thread);
      const textStream = createTextStreamBridge();
      let streamedReplyPromise: Promise<SentMessage> | undefined;
      const startStreamingReply = () => {
        if (!streamedReplyPromise) {
          streamedReplyPromise = thread.post(
            createNormalizingStream(textStream.iterable, ensureBlockSpacing)
          );
        }
      };
      await progress.start();
      let persistedAtLeastOnce = false;

      try {
        const toolChannelId = preparedState.artifacts.assistantContextChannelId ?? channelId;
        const reply = await botDeps.generateAssistantReply(userText, {
          assistant: {
            userName: botConfig.userName
          },
          requester: {
            userId: message.author.userId,
            userName: message.author.userName ?? fallbackIdentity?.userName,
            fullName: message.author.fullName ?? fallbackIdentity?.fullName
          },
          conversationContext: preparedState.routingContext ?? preparedState.conversationContext,
          artifactState: preparedState.artifacts,
          configuration: preparedState.configuration,
          channelConfiguration: preparedState.channelConfiguration,
          userAttachments,
          correlation: {
            threadId,
            threadTs,
            workflowRunId,
            channelId,
            requesterId: message.author.userId
          },
          toolChannelId,
          sandbox: {
            sandboxId: preparedState.sandboxId
          },
          onStatus: (status) => progress.setStatus(status),
          onTextDelta: (deltaText) => {
            startStreamingReply();
            textStream.push(deltaText);
          }
        });
        textStream.end();
        const diagnosticsContext = {
          slackThreadId: threadId,
          slackUserId: message.author.userId,
          slackChannelId: channelId,
          workflowRunId,
          assistantUserName: botConfig.userName,
          modelId: botConfig.modelId
        };
        const diagnosticsAttributes = {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "app.ai.outcome": reply.diagnostics.outcome,
          "app.ai.assistant_messages": reply.diagnostics.assistantMessageCount,
          "app.ai.tool_results": reply.diagnostics.toolResultCount,
          "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
          "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
          "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
          ...(reply.diagnostics.stopReason
            ? { "app.ai.stop_reason": reply.diagnostics.stopReason }
            : {}),
          ...(reply.diagnostics.errorMessage
            ? { "error.message": reply.diagnostics.errorMessage }
            : {})
        };
        if (reply.diagnostics.outcome === "success") {
          logInfo("agent_turn_diagnostics", diagnosticsContext, diagnosticsAttributes, "Agent turn diagnostics");
        } else if (reply.diagnostics.outcome === "provider_error") {
          const providerError =
            reply.diagnostics.providerError ??
            new Error(reply.diagnostics.errorMessage ?? "Provider error without explicit message");
          logException(
            providerError,
            "agent_turn_provider_error",
            diagnosticsContext,
            diagnosticsAttributes,
            "Agent turn failed with provider error"
          );
        } else {
          logWarn(
            "agent_turn_diagnostics",
            diagnosticsContext,
            diagnosticsAttributes,
            "Agent turn completed with execution failure"
          );
        }

        markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
          replied: true,
          skippedReason: undefined
        });

        upsertConversationMessage(preparedState.conversation, {
          id: generateConversationId("assistant"),
          role: "assistant",
          text: normalizeConversationText(reply.text) || "[empty response]",
          createdAtMs: Date.now(),
          author: {
            userName: botConfig.userName,
            isBot: true
          },
          meta: {
            replied: true
          }
        });

        const artifactStatePatch: Partial<ThreadArtifactsState> = reply.artifactStatePatch
          ? { ...reply.artifactStatePatch }
          : {};

        const replyFiles = reply.files && reply.files.length > 0 ? reply.files : undefined;
        if (!streamedReplyPromise) {
          await thread.post(buildSlackOutputMessage(reply.text, { files: replyFiles }));
        } else {
          await streamedReplyPromise;
        }

        const shouldPersistArtifacts = Object.keys(artifactStatePatch).length > 0;
        const nextArtifacts = shouldPersistArtifacts
          ? mergeArtifactsState(preparedState.artifacts, artifactStatePatch)
          : undefined;
        preparedState.conversation.processing.activeTurnId = undefined;
        preparedState.conversation.processing.lastCompletedAtMs = Date.now();
        updateConversationStats(preparedState.conversation);
        await persistThreadState(thread, {
          artifacts: nextArtifacts,
          conversation: preparedState.conversation,
          sandboxId: reply.sandboxId
        });
        persistedAtLeastOnce = true;

        const assistantMessageCount = preparedState.conversation.messages.filter(
          (m) => m.role === "assistant"
        ).length;
        if (assistantMessageCount === 1 && channelId && threadTs) {
          void generateThreadTitle(userText, reply.text)
            .then((title) => getSlackAdapter().setAssistantTitle(channelId, threadTs, title))
            .catch((error) => {
              logWarn(
                "thread_title_generation_failed",
                {
                  slackThreadId: threadId,
                  slackUserId: message.author.userId,
                  slackChannelId: channelId,
                  workflowRunId,
                  assistantUserName: botConfig.userName,
                  modelId: botConfig.routerModelId
                },
                { "error.message": error instanceof Error ? error.message : String(error) },
                "Thread title generation failed"
              );
            });
        }

        if (streamedReplyPromise && replyFiles) {
          await thread.post({ markdown: "", files: replyFiles });
        }
      } finally {
        textStream.end();
        if (!persistedAtLeastOnce) {
          preparedState.conversation.processing.activeTurnId = undefined;
          preparedState.conversation.processing.lastCompletedAtMs = Date.now();
          markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
            replied: false,
            skippedReason: "reply failed"
          });
          await persistThreadState(thread, {
            conversation: preparedState.conversation
          });
        }
        await progress.stop();
      }
    }
  );
}

async function initializeAssistantThread(event: {
  threadId: string;
  channelId: string;
  threadTs: string;
  sourceChannelId?: string;
}): Promise<void> {
  const slack = getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);

  if (!event.sourceChannelId) {
    return;
  }

  const thread = ThreadImpl.fromJSON({
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: event.channelId,
    id: event.threadId,
    isDM: event.channelId.startsWith("D")
  });
  const currentArtifacts = coerceThreadArtifactsState(await thread.state);
  const nextArtifacts = mergeArtifactsState(currentArtifacts, {
    assistantContextChannelId: event.sourceChannelId
  });
  await persistThreadState(thread, {
    artifacts: nextArtifacts
  });
}

export const appSlackRuntime = createAppSlackRuntime<
  PreparedTurnState,
  AppRuntimeAssistantLifecycleEvent
>({
  assistantUserName: botConfig.userName,
  modelId: botConfig.modelId,
  now: () => Date.now(),
  getThreadId,
  getChannelId,
  getWorkflowRunId,
  stripLeadingBotMention,
  withSpan,
  logWarn,
  logException,
  prepareTurnState,
  persistPreparedState: async ({ thread, preparedState }) => {
    await persistThreadState(thread, {
      conversation: preparedState.conversation
    });
  },
  getPreparedConversationContext: (preparedState) =>
    preparedState.routingContext ?? preparedState.conversationContext,
  shouldReplyInSubscribedThread,
  onSubscribedMessageSkipped: async ({ thread, preparedState, decision, completedAtMs }) => {
    markConversationMessage(preparedState.conversation, preparedState.userMessageId, {
      replied: false,
      skippedReason: decision.reason
    });
    preparedState.conversation.processing.activeTurnId = undefined;
    preparedState.conversation.processing.lastCompletedAtMs = completedAtMs;
    updateConversationStats(preparedState.conversation);
    await persistThreadState(thread, {
      conversation: preparedState.conversation
    });
  },
  replyToThread,
  initializeAssistantThread
});

bot.onNewMention(appSlackRuntime.handleNewMention);
bot.onSubscribedMessage(appSlackRuntime.handleSubscribedMessage);
bot.onAssistantThreadStarted((event: AppRuntimeAssistantLifecycleEvent) =>
  appSlackRuntime.handleAssistantThreadStarted(event)
);
bot.onAssistantContextChanged((event: AppRuntimeAssistantLifecycleEvent) =>
  appSlackRuntime.handleAssistantContextChanged(event)
);
bot.onSlashCommand("/jr", (event) =>
  withSpan(
    "workflow.slash_command",
    "workflow.slash_command",
    { slackUserId: event.user.userId },
    async () => {
      try {
        await handleSlashCommand(event);
      } catch (error) {
        logException(error, "slash_command_failed", { slackUserId: event.user.userId });
        throw error;
      }
    }
  )
);

bot.onAppHomeOpened((event) =>
  withSpan(
    "workflow.app_home_opened",
    "workflow.app_home_opened",
    { slackUserId: event.userId },
    async () => {
      try {
        await publishAppHomeView(getSlackClient(), event.userId, getUserTokenStore());
      } catch (error) {
        logException(error, "app_home_opened_failed", { slackUserId: event.userId });
      }
    }
  )
);

bot.onAction("app_home_disconnect", async (event) => {
  const provider = event.value;
  if (!provider) return;
  const userId = event.user.userId;
  await withSpan(
    "workflow.app_home_disconnect",
    "workflow.app_home_disconnect",
    { slackUserId: userId },
    async () => {
      try {
        await getUserTokenStore().delete(userId, provider);
        await publishAppHomeView(getSlackClient(), userId, getUserTokenStore());
      } catch (error) {
        logException(error, "app_home_disconnect_failed", { slackUserId: userId }, {
          "app.credential.provider": provider
        });
      }
    }
  );
});
