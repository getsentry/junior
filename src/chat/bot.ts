import { Chat } from "chat";
import type { Attachment } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { z } from "zod";
import "@/chat/chat-background-patch";
import {
  createAppSlackRuntime,
  type AppRuntimeAssistantLifecycleEvent,
  type AppRuntimeIncomingMessage,
  type AppRuntimeThreadHandle
} from "@/chat/app-runtime";
import { botConfig } from "@/chat/config";
import { buildConversationStatePatch, coerceThreadConversationState } from "@/chat/conversation-state";
import type {
  ConversationCompaction,
  ConversationMessage,
  ThreadConversationState
} from "@/chat/conversation-state";
import { logException, logInfo, logWarn, toOptionalString, withSpan } from "@/chat/observability";
import { buildSlackOutputMessage } from "@/chat/output";
import { generateAssistantReply } from "@/chat/respond";
import {
  buildArtifactStatePatch,
  coerceThreadArtifactsState,
  type ThreadArtifactsState
} from "@/chat/slack-actions/types";
import { lookupSlackUser } from "@/chat/slack-user";
import { createStateAdapter } from "@/chat/state";
import { completeObject, completeText, GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";

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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function getThreadId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { id?: unknown }).id) ??
    toOptionalString((message as { threadId?: unknown }).threadId) ??
    toOptionalString((message as { threadTs?: unknown }).threadTs)
  );
}

function getThreadTs(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((message as { threadTs?: unknown }).threadTs) ??
    toOptionalString((thread as { threadTs?: unknown }).threadTs)
  );
}

function getWorkflowRunId(thread: unknown, message: unknown): string | undefined {
  return (
    toOptionalString((thread as { runId?: unknown }).runId) ??
    toOptionalString((message as { runId?: unknown }).runId)
  );
}

function getChannelId(message: unknown): string | undefined {
  return toOptionalString((message as { channelId?: unknown }).channelId);
}

interface AssistantThreadMeta {
  channelId: string;
  threadTs: string;
  updatedAtMs: number;
}

function getSlackAdapter(): SlackAdapter {
  return bot.getAdapter("slack") as SlackAdapter;
}

const assistantThreadMetaById = new Map<string, AssistantThreadMeta>();
const ASSISTANT_THREAD_META_MAX = 500;
const ASSISTANT_THREAD_META_TTL_MS = 1000 * 60 * 60 * 24;
const STATUS_UPDATE_DEBOUNCE_MS = 1000;

function pruneAssistantThreadMeta(nowMs: number): void {
  for (const [threadId, meta] of assistantThreadMetaById) {
    if (nowMs - meta.updatedAtMs > ASSISTANT_THREAD_META_TTL_MS) {
      assistantThreadMetaById.delete(threadId);
    }
  }

  if (assistantThreadMetaById.size <= ASSISTANT_THREAD_META_MAX) {
    return;
  }

  const overflow = assistantThreadMetaById.size - ASSISTANT_THREAD_META_MAX;
  const oldest = [...assistantThreadMetaById.entries()]
    .sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs)
    .slice(0, overflow);

  for (const [threadId] of oldest) {
    assistantThreadMetaById.delete(threadId);
  }
}

function createProgressReporter(thread: {
  id?: string;
  startTyping?: (status?: string) => Promise<void>;
}) {
  let active = false;
  let currentStatus = "Working...";
  let lastStatusAt = 0;
  let pendingStatus: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const postAssistantStatus = async (text: string): Promise<void> => {
    currentStatus = text;
    lastStatusAt = Date.now();
    try {
      await thread.startTyping?.(text);
    } catch {
      // Best effort only.
    }

    const threadId = toOptionalString(thread.id);
    const assistantThread = threadId ? assistantThreadMetaById.get(threadId) : undefined;
    if (!assistantThread || !threadId) {
      return;
    }
    assistantThread.updatedAtMs = Date.now();

    try {
      await getSlackAdapter().setAssistantStatus(
        assistantThread.channelId,
        assistantThread.threadTs,
        text,
        [text]
      );
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
      await postAssistantStatus(next);
    }
  };

  return {
    async start() {
      active = true;
      clearPending();
      await postAssistantStatus("Thinking...");
    },
    async stop() {
      active = false;
      clearPending();
    },
    async setStatus(text: string) {
      if (!active || !text || text === currentStatus) {
        return;
      }

      const now = Date.now();
      const elapsed = now - lastStatusAt;
      if (elapsed >= STATUS_UPDATE_DEBOUNCE_MS) {
        clearPending();
        await postAssistantStatus(text);
        return;
      }

      pendingStatus = text;
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

interface ThreadMessageSnapshot {
  id?: string;
  text?: string | null;
  metadata?: {
    dateSent?: Date;
  };
  author?: {
    userId?: string;
    isBot?: boolean | "unknown";
    isMe?: boolean;
    userName?: string;
    fullName?: string;
  };
}

interface UserInputAttachment {
  data: Buffer;
  mediaType: string;
  filename?: string;
}

const MAX_USER_ATTACHMENTS = 3;
const MAX_USER_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
      } else if (attachment.url) {
        const response = await fetch(attachment.url);
        if (!response.ok) throw new Error(`attachment fetch failed: ${response.status}`);
        data = Buffer.from(await response.arrayBuffer());
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

function renderConversationMessageLine(message: ConversationMessage): string {
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
  return `[${message.role}] ${displayName}: ${message.text}${markerSuffix}`;
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
    lines.push(renderConversationMessageLine(message));
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
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    workflowRunId?: string;
  }
): Promise<string> {
  const transcript = messages.map((message) => renderConversationMessageLine(message)).join("\n");

  try {
    const result = await completeText({
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
    const summary = await summarizeConversationChunk(compactedChunk, context);
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

function createConversationMessageFromThreadSnapshot(
  entry: ThreadMessageSnapshot,
  fallbackPrefix: "backfill" | "turn"
): ConversationMessage | null {
  const rawText = typeof entry.text === "string" ? normalizeConversationText(entry.text) : "";
  if (!rawText) {
    return null;
  }

  return {
    id: toOptionalString(entry.id) ?? generateConversationId(fallbackPrefix),
    role: entry.author?.isMe ? "assistant" : "user",
    text: rawText,
    createdAtMs:
      entry.metadata?.dateSent instanceof Date && Number.isFinite(entry.metadata.dateSent.getTime())
        ? entry.metadata.dateSent.getTime()
        : Date.now(),
    author: {
      userId: toOptionalString(entry.author?.userId),
      userName: toOptionalString(entry.author?.userName),
      fullName: toOptionalString(entry.author?.fullName),
      isBot: typeof entry.author?.isBot === "boolean" ? entry.author.isBot : undefined
    }
  };
}

async function seedConversationBackfill(
  thread: {
    messages?: AsyncIterable<ThreadMessageSnapshot>;
    recentMessages?: ThreadMessageSnapshot[];
    refresh?: () => Promise<void>;
  },
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
    if (thread.messages) {
      const fetchedNewestFirst: ThreadMessageSnapshot[] = [];
      for await (const entry of thread.messages) {
        fetchedNewestFirst.push(entry);
        if (fetchedNewestFirst.length >= BACKFILL_MESSAGE_LIMIT) {
          break;
        }
      }
      fetchedNewestFirst.reverse();
      for (const entry of fetchedNewestFirst) {
        const message = createConversationMessageFromThreadSnapshot(entry, "backfill");
        if (message) {
          seeded.push(message);
        }
      }
      if (seeded.length > 0) {
        source = "thread_fetch";
      }
    }
  } catch {
    // Fallback below.
  }

  if (seeded.length === 0) {
    try {
      await thread.refresh?.();
    } catch {
      // Best effort only.
    }

    const fromRecent = (thread.recentMessages ?? []).slice(-BACKFILL_MESSAGE_LIMIT);
    for (const entry of fromRecent) {
      const message = createConversationMessageFromThreadSnapshot(entry, "backfill");
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
  if (!text) {
    return { shouldReply: false, reason: "empty message" };
  }

  if (args.isExplicitMention) {
    return { shouldReply: true, reason: "explicit mention" };
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

    const result = await completeObject({
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

export const bot = new Chat({
  userName: botConfig.userName,
  adapters: {
    slack: createSlackAdapter()
  },
  state: createStateAdapter()
});

interface ThreadTurnHandle extends AppRuntimeThreadHandle {
  messages?: AsyncIterable<ThreadMessageSnapshot>;
  recentMessages?: ThreadMessageSnapshot[];
  state?: Promise<unknown | null>;
}

interface IncomingThreadMessage extends AppRuntimeIncomingMessage {
  attachments?: Attachment[];
}

interface PreparedTurnState {
  artifacts: ThreadArtifactsState;
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
  thread: ThreadTurnHandle,
  patch: {
    artifacts?: ThreadArtifactsState;
    conversation?: ThreadConversationState;
    sandboxId?: string;
  }
): Promise<void> {
  if (!thread.setState) {
    return;
  }

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

async function prepareTurnState(args: {
  explicitMention: boolean;
  message: IncomingThreadMessage;
  thread: ThreadTurnHandle;
  userText: string;
  context: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    workflowRunId?: string;
  };
}): Promise<PreparedTurnState> {
  const existingState = args.thread.state ? await args.thread.state : null;
  const existingSandboxId =
    existingState && typeof existingState === "object"
      ? toOptionalString((existingState as { app_sandbox_id?: unknown }).app_sandbox_id)
      : undefined;
  const artifacts = coerceThreadArtifactsState(existingState);
  const conversation = coerceThreadConversationState(existingState);

  await seedConversationBackfill(args.thread, conversation);

  const normalizedUserText = normalizeConversationText(args.userText) || "[non-text message]";
  const incomingUserMessage: ConversationMessage = {
    id: toOptionalString(args.message.id) ?? generateConversationId("turn"),
    role: "user",
    text: normalizedUserText,
    createdAtMs:
      args.message.metadata?.dateSent instanceof Date && Number.isFinite(args.message.metadata.dateSent.getTime())
        ? args.message.metadata.dateSent.getTime()
        : Date.now(),
    author: {
      userId: args.message.author.userId,
      userName: args.message.author.userName,
      fullName: args.message.author.fullName,
      isBot: typeof args.message.author.isBot === "boolean" ? args.message.author.isBot : undefined
    },
    meta: {
      explicitMention: args.explicitMention
    }
  };

  const userMessageId = upsertConversationMessage(conversation, incomingUserMessage);

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
    conversation,
    sandboxId: existingSandboxId,
    conversationContext,
    routingContext,
    userMessageId
  };
}

async function replyToThread(
  thread: ThreadTurnHandle,
  message: IncomingThreadMessage,
  options: {
    explicitMention?: boolean;
    preparedState?: PreparedTurnState;
  } = {}
) {
  if (message.author.isMe) {
    return;
  }

  const threadId = getThreadId(thread, message);
  const threadTs = getThreadTs(thread, message);
  const channelId = getChannelId(message);
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
      const userText = stripLeadingBotMention(message.text ?? "", {
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

      const fallbackIdentity = await lookupSlackUser(message.author.userId);
      const userAttachments = await resolveUserAttachments(message.attachments, {
        threadId,
        requesterId: message.author.userId,
        channelId,
        workflowRunId
      });

      const progress = createProgressReporter(thread);
      await progress.start();
      let persistedAtLeastOnce = false;

      try {
        const reply = await generateAssistantReply(userText, {
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
          userAttachments,
          correlation: {
            threadId,
            threadTs,
            workflowRunId,
            channelId,
            requesterId: message.author.userId
          },
          sandbox: {
            sandboxId: preparedState.sandboxId
          },
          onStatus: (status) => progress.setStatus(status)
        });
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

        await thread.post(
          buildSlackOutputMessage(reply.text, {
            files: reply.files
          })
        );

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
      } finally {
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
}): Promise<void> {
  const nowMs = Date.now();
  assistantThreadMetaById.set(event.threadId, {
    channelId: event.channelId,
    threadTs: event.threadTs,
    updatedAtMs: nowMs
  });
  pruneAssistantThreadMeta(nowMs);

  const slack = getSlackAdapter();
  await slack.setAssistantTitle(event.channelId, event.threadTs, "Junior");
  await slack.setSuggestedPrompts(event.channelId, event.threadTs, [
    { title: "Summarize thread", message: "Summarize the latest discussion in this thread." },
    { title: "Draft a reply", message: "Draft a concise reply I can send." },
    { title: "Generate image", message: "Generate an image based on this conversation." }
  ]);
}

export const appSlackRuntime = createAppSlackRuntime<
  PreparedTurnState,
  ThreadTurnHandle,
  IncomingThreadMessage,
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
