/**
 * Context compaction.
 *
 * This module bounds visible Pi history for long conversations. It strips
 * runtime-only turn context before summarizing, commits a session-log projection
 * reset, and keeps recent user intent. Compaction must not preserve runtime
 * bootstrap context as durable conversation history.
 */
import { THREAD_STATE_TTL_MS } from "chat";
import {
  estimateContextTokens,
  estimateTokens,
} from "@earendil-works/pi-agent-core";
import { botConfig } from "@/chat/config";
import type { completeText } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  estimateTextTokens,
  getAgentContextCompactionTriggerTokens,
} from "@/chat/services/context-budget";
import { commitMessages } from "@/chat/state/session-log";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { logWarn, setSpanAttributes } from "@/chat/logging";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/respond-helpers";
import { updateConversationStats } from "@/chat/services/conversation-memory";

const RETAINED_USER_MESSAGE_TOKENS = 20_000;
const MAX_SUMMARY_INPUT_CHARS = 80_000;
const MAX_VISIBLE_CONTEXT_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_RENDERED_MESSAGE_CHARS = 4_000;
const COMPACTION_SUMMARY_PREFIX =
  "Context handoff summary for future Junior turns:";
const OMITTED_OLDER_CONTEXT_NOTICE = "[older context omitted]";

export interface ContextCompactorDeps {
  completeText: typeof completeText;
  autoCompactionTriggerTokens?: number;
}

export interface ContextCompactor {
  maybeCompact: (args: CompactContextArgs) => Promise<CompactContextResult>;
}

export interface CompactContextArgs {
  conversation: ThreadConversationState;
  conversationContext?: string;
  conversationId: string;
  onCompactionStart?: () => void;
  piMessages: PiMessage[];
  metadata?: {
    channelId?: string;
    requesterId?: string;
    runId?: string;
    threadId?: string;
  };
}

export interface CompactContextResult {
  compacted: boolean;
  piMessages?: PiMessage[];
  reason?: "below_threshold" | "missing_context" | "summary_failed";
}

function textPart(value: unknown): string | undefined {
  if (
    value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  return undefined;
}

function messageText(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : "";
  }
  return content.map(textPart).filter(Boolean).join("\n").trim();
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

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isCompactionSummary(text: string): boolean {
  return text.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX);
}

function isPayloadHeavy(text: string): boolean {
  return /<data_base64>[\s\S]*?<\/data_base64>|data:image\/[a-z0-9.+-]+;base64,/i.test(
    text,
  );
}

function userMessage(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as PiMessage;
}

/** Build retained user messages for a compacted Pi replacement history. */
export function selectRetainedUserMessages(
  messages: PiMessage[],
  maxTokens = RETAINED_USER_MESSAGE_TOKENS,
): PiMessage[] {
  const stripped = stripRuntimeTurnContext(messages);
  const selected: string[] = [];
  let remaining = maxTokens;

  for (const message of [...stripped].reverse()) {
    if ((message as { role?: unknown }).role !== "user" || remaining <= 0) {
      continue;
    }

    const text = sanitizeText(messageText(message));
    if (!text || isCompactionSummary(text) || isPayloadHeavy(text)) {
      continue;
    }

    const tokens = estimateTextTokens(text);
    if (tokens <= remaining) {
      selected.push(text);
      remaining -= tokens;
      continue;
    }

    const truncated = truncateToTokenBudget(text, remaining);
    if (truncated) {
      selected.push(truncated);
    }
    break;
  }

  return selected.reverse().map(userMessage);
}

function renderMessageForSummary(message: PiMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  if (typeof role !== "string") {
    return undefined;
  }
  const text = sanitizeText(messageText(message));
  if (!text) {
    return undefined;
  }
  const trimmed =
    text.length > MAX_RENDERED_MESSAGE_CHARS
      ? `${text.slice(0, MAX_RENDERED_MESSAGE_CHARS).trimEnd()}...`
      : text;
  return `[${role}] ${trimmed}`;
}

function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const prefix = `${OMITTED_OLDER_CONTEXT_NOTICE}\n`;
  return `${prefix}${text.slice(Math.max(0, text.length - maxChars + prefix.length))}`;
}

function renderSummaryInput(
  piMessages: PiMessage[],
  conversationContext?: string,
): string {
  const lines: string[] = [];
  const visibleContext = conversationContext?.trim();
  if (visibleContext) {
    lines.push(
      "<visible-thread-context>",
      keepTail(visibleContext, MAX_VISIBLE_CONTEXT_CHARS),
      "</visible-thread-context>",
      "",
    );
  }

  const renderedPiMessages = stripRuntimeTurnContext(piMessages)
    .map(renderMessageForSummary)
    .filter((line): line is string => Boolean(line));

  if (renderedPiMessages.length > 0) {
    const piEnvelopeChars = "<pi-history>\n</pi-history>".length + 2;
    const piHistory = keepTail(
      renderedPiMessages.join("\n"),
      Math.max(
        1,
        MAX_SUMMARY_INPUT_CHARS - lines.join("\n").length - piEnvelopeChars,
      ),
    );
    lines.push("<pi-history>", piHistory, "</pi-history>");
  }

  return keepTail(lines.join("\n"), MAX_SUMMARY_INPUT_CHARS);
}

/** Ask the fast model for a bounded handoff summary of durable thread context. */
async function summarizeContext(
  args: {
    conversationContext?: string;
    piMessages: PiMessage[];
    metadata?: CompactContextArgs["metadata"];
  },
  deps: ContextCompactorDeps,
): Promise<string> {
  const source = renderSummaryInput(args.piMessages, args.conversationContext);
  const result = await deps.completeText({
    modelId: botConfig.fastModelId,
    messageAttributeMode: "metadata",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          "You are performing a CONTEXT CHECKPOINT COMPACTION for Junior.",
          "Create a concise handoff summary for another model that will continue this Slack thread.",
          "",
          "Include:",
          "- Current outstanding asks",
          "- Key decisions, completed work, and outcomes",
          "- Durable constraints, user preferences, IDs, URLs, artifacts, canvas links, sandbox references, and auth state",
          "- Clear next steps and unresolved blockers",
          "",
          "Do not invent details. Do not include raw secrets or credentials.",
          "",
          source,
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    metadata: {
      modelId: botConfig.fastModelId,
      threadId: args.metadata?.threadId ?? "",
      channelId: args.metadata?.channelId ?? "",
      requesterId: args.metadata?.requesterId ?? "",
      runId: args.metadata?.runId ?? "",
    },
  });

  const summary = result.text.trim();
  if (!summary) {
    throw new Error("Compaction summary was empty");
  }
  return summary.slice(0, MAX_SUMMARY_CHARS);
}

function estimateHistoryTokens(messages: PiMessage[]): number {
  const stripped = stripRuntimeTurnContext(messages);
  const usageEstimate = estimateContextTokens(stripped).tokens;
  const structuralEstimate = stripped.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  return Math.max(usageEstimate, structuralEstimate);
}

/** Build a compacted Pi projection from retained recent asks plus the summary. */
function buildReplacementHistory(args: {
  messages: PiMessage[];
  summary: string;
}): PiMessage[] {
  return [
    ...selectRetainedUserMessages(args.messages),
    userMessage(`${COMPACTION_SUMMARY_PREFIX}\n${args.summary}`),
  ];
}

type CompactionSource =
  | {
      estimatedTokens: number;
      messages: PiMessage[];
    }
  | {
      reason: "missing_context";
    };

function loadCompactionSource(messages: PiMessage[]): CompactionSource {
  if (messages.length > 0) {
    return {
      estimatedTokens: estimateHistoryTokens(messages),
      messages,
    };
  }
  return { reason: "missing_context" };
}

/** Decide whether this turn crosses the compaction threshold and perform it. */
async function maybeCompactWithDeps(
  args: CompactContextArgs,
  deps: ContextCompactorDeps,
): Promise<CompactContextResult> {
  const source = loadCompactionSource(args.piMessages);
  if ("reason" in source) {
    return { compacted: false, reason: source.reason };
  }

  const triggerTokens =
    deps.autoCompactionTriggerTokens ??
    getAgentContextCompactionTriggerTokens();
  if (source.estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }

  args.onCompactionStart?.();

  let summary: string;
  try {
    summary = await summarizeContext(
      {
        conversationContext: args.conversationContext,
        piMessages: source.messages,
        metadata: args.metadata,
      },
      deps,
    );
  } catch (error) {
    logWarn(
      "context_compaction_summary_failed",
      {
        slackThreadId: args.metadata?.threadId,
        slackUserId: args.metadata?.requesterId,
        slackChannelId: args.metadata?.channelId,
        runId: args.metadata?.runId,
        assistantUserName: botConfig.userName,
        modelId: botConfig.fastModelId,
      },
      {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      },
      "Context compaction failed; continuing with prior history",
    );
    return { compacted: false, reason: "summary_failed" };
  }

  return await writeCompactedThreadContext(args, source.messages, summary, {
    estimatedTokens: source.estimatedTokens,
    triggerTokens,
  });
}

/**
 * Commit the compacted projection reset so later turns read only the active
 * session history, not the pre-compaction runtime transcript.
 */
async function writeCompactedThreadContext(
  args: CompactContextArgs,
  sourceMessages: PiMessage[],
  summary: string,
  context: {
    estimatedTokens: number;
    triggerTokens?: number;
  },
): Promise<CompactContextResult> {
  const replacement = buildReplacementHistory({
    messages: trimTrailingAssistantMessages(sourceMessages),
    summary,
  });
  await commitMessages({
    conversationId: args.conversationId,
    messages: replacement,
    ttlMs: THREAD_STATE_TTL_MS,
  });

  updateConversationStats(args.conversation);
  setSpanAttributes({
    "app.compaction.input_messages": sourceMessages.length,
    "app.compaction.retained_messages": replacement.length - 1,
    "app.compaction.summary_chars": summary.length,
    ...(context.triggerTokens !== undefined
      ? { "app.compaction.trigger_tokens": context.triggerTokens }
      : {}),
    "app.context_tokens_estimated": context.estimatedTokens,
  });

  return {
    compacted: true,
    piMessages: replacement,
  };
}

/** Build the service that owns local context compaction. */
export function createContextCompactor(
  deps: ContextCompactorDeps,
): ContextCompactor {
  return {
    maybeCompact: async (args) => await maybeCompactWithDeps(args, deps),
  };
}
