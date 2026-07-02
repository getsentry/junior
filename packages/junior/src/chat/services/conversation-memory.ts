import { botConfig } from "@/chat/config";
import type { completeText } from "@/chat/pi/client";
import type {
  ConversationCompaction,
  ConversationMessage,
  ThreadConversationState,
} from "@/chat/state/conversation";
import { logWarn, setSpanAttributes } from "@/chat/logging";
import {
  calculateContextCompactionTargetTokens,
  estimateTextTokens,
  getConversationContextCompactionTriggerTokens,
} from "@/chat/services/context-budget";
import {
  parseSlackMessageTs,
  type SlackMessageTs,
} from "@/chat/slack/timestamp";
import { escapeXml } from "@/chat/xml";

const CONTEXT_MIN_LIVE_MESSAGES = 12;
const CONTEXT_COMPACTION_BATCH_SIZE = 24;
const CONTEXT_MAX_COMPACTIONS = 16;
const CONTEXT_MAX_MESSAGE_CHARS = 3200;
const SLACK_USER_ID_DISPLAY_PATTERN = /^[UW][A-Z0-9]{5,}$/;

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
  const displayName = conversationAuthorDisplayName(message);

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

function conversationAuthorDisplayName(message: ConversationMessage): string {
  const author = message.author;
  const fullName = authorDisplayField(author?.fullName, author?.userId);
  const userName = authorDisplayField(author?.userName, author?.userId);
  return (
    fullName ??
    userName ??
    (message.role === "assistant" ? botConfig.userName : message.role)
  );
}

function authorDisplayField(
  value: string | undefined,
  userId: string | undefined,
): string | undefined {
  if (!value || value === userId || SLACK_USER_ID_DISPLAY_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

export function updateConversationStats(
  conversation: ThreadConversationState,
): void {
  const contextText = buildConversationContext(conversation);
  conversation.stats.estimatedContextTokens = estimateTextTokens(
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

/**
 * Render thread history as structured XML. Each compaction and message is
 * wrapped with index/ts metadata so the model can reference prior items
 * individually instead of treating the whole block as one flat narrative.
 */
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
        `  <compaction index="${index + 1}" covered_messages="${compaction.coveredMessageIds.length}" created_at="${new Date(compaction.createdAtMs).toISOString()}">`,
        compaction.summary,
        "  </compaction>",
      );
    }
    lines.push("</thread-compactions>");
  }

  if (messages.length > 0) {
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push("<thread-transcript>");
    for (const [index, message] of messages.entries()) {
      const author = escapeXml(conversationAuthorDisplayName(message));
      const actorIdAttr = message.author?.userId
        ? ` actor_id="${escapeXml(message.author.userId)}"`
        : "";
      const ts = new Date(message.createdAtMs).toISOString();
      const slackTsAttr = message.meta?.slackTs
        ? ` slack_ts="${escapeXml(message.meta.slackTs)}"`
        : "";
      lines.push(
        `  <message index="${index + 1}" ts="${ts}" role="${message.role}" author="${author}"${actorIdAttr}${slackTsAttr}>`,
        renderConversationMessageLine(message, conversation),
        "  </message>",
      );
    }
    lines.push("</thread-transcript>");
  }
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
            "Keep the summary factual and concise. Do not invent details.",
            "",
            "Output exactly three XML sections in this order:",
            "<active-asks> one bullet per outstanding user ask that has not been narrowed, answered, or replaced by a later turn. Omit the section body if none. </active-asks>",
            "<resolved-or-replaced-asks> one bullet per ask that has been replaced, narrowed, answered, or already acted on in this segment. Include the replacement/outcome inline. Omit the section body if none. </resolved-or-replaced-asks>",
            "<facts> one bullet per durable fact useful regardless of scope: names, ids, URLs, decisions, locations, preferences, constraints that remain true. Omit the section body if none. </facts>",
            "",
            "Do not output any text outside the three sections.",
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
        "exception.message":
          error instanceof Error ? error.message : String(error),
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
    modelId: botConfig.fastModelId,
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
    metadata: {
      modelId: botConfig.fastModelId,
    },
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

  const triggerTokens = getConversationContextCompactionTriggerTokens();
  const targetTokens = calculateContextCompactionTargetTokens(triggerTokens);
  while (
    estimatedTokens > triggerTokens &&
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
      "app.compaction.trigger_tokens": triggerTokens,
      "app.compaction.target_tokens": targetTokens,
      "app.context_tokens_estimated": estimatedTokens,
    });

    if (estimatedTokens <= targetTokens) {
      break;
    }
  }
}

/** Build the service that owns durable conversation memory compaction and titles. */
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

export function isHumanConversationMessage(
  message: ConversationMessage,
): boolean {
  return message.role === "user" && message.author?.isBot !== true;
}

/** Return the native Slack timestamp for a persisted conversation message. */
export function getConversationMessageSlackTs(
  message: ConversationMessage,
): SlackMessageTs | undefined {
  return parseSlackMessageTs(message.meta?.slackTs);
}
