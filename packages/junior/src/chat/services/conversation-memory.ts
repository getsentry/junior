import type { Message, Thread } from "chat";
import { botConfig } from "@/chat/config";
import { completeText } from "@/chat/pi/client";
import { getSlackMessageTs } from "@/chat/slack/message";
import type {
  ConversationCompaction,
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { toOptionalString } from "@/chat/coerce";
import { logWarn, setSpanAttributes } from "@/chat/logging";

const CONTEXT_COMPACTION_TRIGGER_TOKENS = 9000;
const CONTEXT_COMPACTION_TARGET_TOKENS = 7000;
const CONTEXT_MIN_LIVE_MESSAGES = 12;
const CONTEXT_COMPACTION_BATCH_SIZE = 24;
const CONTEXT_MAX_COMPACTIONS = 16;
const CONTEXT_MAX_MESSAGE_CHARS = 3200;
const BACKFILL_MESSAGE_LIMIT = 80;

export interface ConversationMemoryDeps {
  completeText: typeof completeText;
}

export interface ConversationMemoryService {
  compactConversationIfNeeded: (
    conversation: ThreadConversationState,
    context: {
      threadId?: string;
      channelId?: string;
      requesterId?: string;
      runId?: string;
    },
  ) => Promise<void>;
  generateThreadTitle: (sourceText: string) => Promise<string>;
}

export function generateConversationId(
  prefix: "assistant" | "backfill" | "compaction" | "turn",
): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeConversationText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, CONTEXT_MAX_MESSAGE_CHARS);
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildImageContextSuffix(
  message: ConversationMessage,
  conversation: ThreadConversationState | undefined,
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
  conversation?: ThreadConversationState,
): string {
  const displayName =
    message.author?.fullName ||
    message.author?.userName ||
    (message.role === "assistant" ? botConfig.userName : message.role);

  const markers: string[] = [];
  if (message.meta?.replied === false) {
    markers.push(
      `assistant skipped: ${message.meta?.skippedReason ?? "no-reply route"}`,
    );
  }
  if (message.meta?.explicitMention) {
    markers.push("explicit mention");
  }

  const markerSuffix = markers.length > 0 ? ` (${markers.join("; ")})` : "";
  const imageContext = buildImageContextSuffix(message, conversation);
  return `[${message.role}] ${displayName}: ${message.text}${imageContext}${markerSuffix}`;
}

export function updateConversationStats(
  conversation: ThreadConversationState,
): void {
  const contextText = buildConversationContext(conversation);
  conversation.stats.estimatedContextTokens = estimateTokenCount(
    contextText ?? "",
  );
  conversation.stats.totalMessageCount = conversation.messages.length;
  conversation.stats.updatedAtMs = Date.now();
}

export function upsertConversationMessage(
  conversation: ThreadConversationState,
  message: ConversationMessage,
): string {
  const existingIndex = conversation.messages.findIndex(
    (entry) => entry.id === message.id,
  );
  if (existingIndex >= 0) {
    conversation.messages[existingIndex] = {
      ...conversation.messages[existingIndex],
      ...message,
      meta: {
        ...conversation.messages[existingIndex]?.meta,
        ...message.meta,
      },
    };
    updateConversationStats(conversation);
    return message.id;
  }

  conversation.messages.push(message);
  updateConversationStats(conversation);
  return message.id;
}

export function markConversationMessage(
  conversation: ThreadConversationState,
  messageId: string | undefined,
  patch: Partial<NonNullable<ConversationMessage["meta"]>>,
): void {
  if (!messageId) return;

  const messageIndex = conversation.messages.findIndex(
    (entry) => entry.id === messageId,
  );
  if (messageIndex < 0) return;

  const current = conversation.messages[messageIndex];
  conversation.messages[messageIndex] = {
    ...current,
    meta: {
      ...(current.meta ?? {}),
      ...patch,
    },
  };
  updateConversationStats(conversation);
}

export function buildConversationContext(
  conversation: ThreadConversationState,
  options: {
    excludeMessageId?: string;
  } = {},
): string | undefined {
  const messages = conversation.messages.filter(
    (entry) => entry.id !== options.excludeMessageId,
  );
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
          `created_at: ${new Date(compaction.createdAtMs).toISOString()}`,
        ].join(" "),
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

function pruneCompactions(
  compactions: ConversationCompaction[],
): ConversationCompaction[] {
  if (compactions.length <= CONTEXT_MAX_COMPACTIONS) {
    return compactions;
  }

  const overflowCount = compactions.length - CONTEXT_MAX_COMPACTIONS + 1;
  const merged = compactions.slice(0, overflowCount);
  const mergedSummary = merged
    .map((entry) => entry.summary)
    .join("\n")
    .slice(0, 3500);
  const mergedIds = merged
    .flatMap((entry) => entry.coveredMessageIds)
    .slice(0, 500);

  const compacted: ConversationCompaction = {
    id: generateConversationId("compaction"),
    createdAtMs: Date.now(),
    summary: mergedSummary,
    coveredMessageIds: mergedIds,
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
    runId?: string;
  },
  deps: ConversationMemoryDeps,
): Promise<string> {
  const transcript = messages
    .map((message) => renderConversationMessageLine(message, conversation))
    .join("\n");

  try {
    const result = await deps.completeText({
      modelId: botConfig.fastModelId,
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
            transcript,
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
      metadata: {
        modelId: botConfig.fastModelId,
        threadId: context.threadId ?? "",
        channelId: context.channelId ?? "",
        requesterId: context.requesterId ?? "",
        runId: context.runId ?? "",
      },
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
        runId: context.runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.fastModelId,
      },
      {
        "error.message": error instanceof Error ? error.message : String(error),
        "app.compaction_messages_covered": messages.length,
      },
      "Compaction summarization failed; using fallback summary",
    );
  }

  return transcript.slice(0, 2800);
}

async function generateThreadTitleWithDeps(
  sourceText: string,
  deps: ConversationMemoryDeps,
): Promise<string> {
  const result = await deps.completeText({
    modelId: botConfig.lightModelId,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "Generate a concise 5-8 word Slack conversation title from the first user message below.",
          "Capture the user's main request.",
          "Reply with ONLY the title, with no quotes or trailing punctuation.",
          "",
          `First user message: ${sourceText.slice(0, 500)}`,
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
  });
  return result.text.trim().slice(0, 60);
}

/** Return the earliest human-authored message known for a thread. */
export function getThreadTitleSourceMessage(
  conversation: ThreadConversationState,
): ConversationMessage | undefined {
  let firstMessage: ConversationMessage | undefined;

  for (const message of conversation.messages) {
    if (!isHumanConversationMessage(message)) {
      continue;
    }

    if (!firstMessage) {
      firstMessage = message;
      continue;
    }

    if (message.createdAtMs < firstMessage.createdAtMs) {
      firstMessage = message;
      continue;
    }

    if (
      message.createdAtMs === firstMessage.createdAtMs &&
      message.id < firstMessage.id
    ) {
      firstMessage = message;
    }
  }

  return firstMessage;
}

async function compactConversationIfNeededWithDeps(
  conversation: ThreadConversationState,
  context: {
    threadId?: string;
    channelId?: string;
    requesterId?: string;
    runId?: string;
  },
  deps: ConversationMemoryDeps,
): Promise<void> {
  updateConversationStats(conversation);
  let estimatedTokens = conversation.stats.estimatedContextTokens;
  setSpanAttributes({
    "app.context_tokens_estimated": estimatedTokens,
  });

  while (
    estimatedTokens > CONTEXT_COMPACTION_TRIGGER_TOKENS &&
    conversation.messages.length > CONTEXT_MIN_LIVE_MESSAGES
  ) {
    const compactCount = Math.min(
      CONTEXT_COMPACTION_BATCH_SIZE,
      conversation.messages.length - CONTEXT_MIN_LIVE_MESSAGES,
    );
    if (compactCount <= 0) {
      break;
    }

    const compactedChunk = conversation.messages.slice(0, compactCount);
    const summary = await summarizeConversationChunk(
      compactedChunk,
      conversation,
      context,
      deps,
    );
    conversation.compactions.push({
      id: generateConversationId("compaction"),
      createdAtMs: Date.now(),
      summary,
      coveredMessageIds: compactedChunk.map((entry) => entry.id),
    });
    conversation.compactions = pruneCompactions(conversation.compactions);
    conversation.messages = conversation.messages.slice(compactCount);
    conversation.stats.compactedMessageCount += compactCount;
    updateConversationStats(conversation);

    estimatedTokens = conversation.stats.estimatedContextTokens;
    setSpanAttributes({
      "app.compaction_messages_covered": compactCount,
      "app.context_tokens_estimated": estimatedTokens,
    });

    if (estimatedTokens <= CONTEXT_COMPACTION_TARGET_TOKENS) {
      break;
    }
  }
}

export function createConversationMemoryService(
  deps: ConversationMemoryDeps,
): ConversationMemoryService {
  return {
    compactConversationIfNeeded: async (conversation, context) =>
      await compactConversationIfNeededWithDeps(conversation, context, deps),
    generateThreadTitle: async (sourceText) =>
      await generateThreadTitleWithDeps(sourceText, deps),
  };
}

const defaultConversationMemoryService = createConversationMemoryService({
  completeText,
});

export const compactConversationIfNeeded =
  defaultConversationMemoryService.compactConversationIfNeeded;
export const generateThreadTitle =
  defaultConversationMemoryService.generateThreadTitle;

function createConversationMessageFromSdkMessage(
  entry: Message,
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
      isBot:
        typeof entry.author.isBot === "boolean"
          ? entry.author.isBot
          : undefined,
    },
    meta: {
      slackTs: getSlackMessageTs(entry),
    },
  };
}

export async function seedConversationBackfill(
  thread: Thread,
  conversation: ThreadConversationState,
  currentTurn: {
    messageId: string;
    messageCreatedAtMs: number;
  },
): Promise<void> {
  if (conversation.backfill.completedAtMs) {
    return;
  }
  if (conversation.messages.length > 0 || conversation.compactions.length > 0) {
    conversation.backfill = {
      completedAtMs: Date.now(),
      source: "recent_messages",
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
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    if (seeded.length > 0) {
      source = "thread_fetch";
    }
  } catch {}

  if (seeded.length === 0) {
    try {
      await thread.refresh();
    } catch {}

    const fromRecent = thread.recentMessages.slice(-BACKFILL_MESSAGE_LIMIT);
    for (const entry of fromRecent) {
      const message = createConversationMessageFromSdkMessage(entry);
      if (message) {
        seeded.push(message);
      }
    }
    source = "recent_messages";
  }

  for (const message of seeded) {
    if (
      message.id !== currentTurn.messageId &&
      message.createdAtMs > currentTurn.messageCreatedAtMs
    ) {
      continue;
    }
    if (
      message.id !== currentTurn.messageId &&
      message.createdAtMs === currentTurn.messageCreatedAtMs &&
      message.id > currentTurn.messageId
    ) {
      continue;
    }
    upsertConversationMessage(conversation, message);
  }

  conversation.backfill = {
    completedAtMs: Date.now(),
    source,
  };
  updateConversationStats(conversation);
}

export function isHumanConversationMessage(
  message: ConversationMessage,
): boolean {
  return message.role === "user" && message.author?.isBot !== true;
}

export function getConversationMessageSlackTs(
  message: ConversationMessage,
): string | undefined {
  return message.meta?.slackTs ?? toOptionalString(message.id);
}
