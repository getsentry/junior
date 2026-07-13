/**
 * Context compaction.
 *
 * This module bounds visible Pi history for long conversations. It strips
 * runtime-only turn context before summarizing and opens replacement epochs in
 * the durable step store. Capacity compaction retains recent user intent;
 * handoff starts a profile-bound epoch with only its summary. Normal checkpoints
 * may later append the current bootstrap; future replacement strips it again.
 */
import {
  estimateContextTokens,
  estimateTokens,
} from "@earendil-works/pi-agent-core";
import { botConfig } from "@/chat/config";
import {
  renderCurrentInstruction,
  unwrapCurrentInstruction,
} from "@/chat/current-instruction";
import type { completeText } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import {
  estimateTextTokens,
  getAgentContextCompactionTriggerTokens,
} from "@/chat/services/context-budget";
import {
  contextProvenance,
  type PiMessageProvenance,
} from "@/chat/state/session-log";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getAgentStepStore } from "@/chat/db";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { logWarn, setSpanAttributes } from "@/chat/logging";
import {
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import { updateConversationStats } from "@/chat/services/conversation-memory";
import { modelIdForProfile, type ModelProfile } from "@/chat/model-profile";

const RETAINED_USER_MESSAGE_TOKENS = 20_000;
const MAX_SUMMARY_INPUT_CHARS = 80_000;
const MAX_VISIBLE_CONTEXT_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_RENDERED_MESSAGE_CHARS = 4_000;
const COMPACTION_SUMMARY_PREFIX =
  "Context compaction summary for future Junior turns:";
// TODO(v0.97.0): Remove support for the deployed "Context handoff summary"
// prefix after pre-rename rows pass the conversation-history retention horizon.
const LEGACY_COMPACTION_SUMMARY_PREFIX =
  "Context handoff summary for future Junior turns:";
const MODEL_HANDOFF_SUMMARY_PREFIX =
  "Model handoff checkpoint. Continue the outstanding request now using this summary as the complete prior context:";
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
    actorId?: string;
    runId?: string;
    threadId?: string;
  };
}

export interface CompactContextResult {
  compacted: boolean;
  piMessages?: PiMessage[];
  reason?: "below_threshold" | "missing_context" | "summary_failed";
}

interface HandoffContextArgs {
  conversationContext?: string;
  conversationId: string;
  metadata?: CompactContextArgs["metadata"];
  piMessages: PiMessage[];
  runtimeContext: PiMessage[];
  signal?: AbortSignal;
  target: {
    modelId: string;
    modelProfile: ModelProfile;
  };
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

/** Render Pi message text for compaction without retaining prompt-only wrappers. */
function messageText(message: PiMessage): string {
  const content = (message as { content?: unknown }).content;
  const unwrapTask = (message as { role?: unknown }).role === "user";
  const displayText = (text: string) =>
    unwrapTask ? (unwrapCurrentInstruction(text) ?? text) : text;

  if (!Array.isArray(content)) {
    return typeof content === "string" ? displayText(content) : "";
  }
  return content
    .map(textPart)
    .filter((text): text is string => Boolean(text))
    .map(displayText)
    .join("\n")
    .trim();
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
  const normalized = text.trimStart();
  return (
    normalized.startsWith(COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(LEGACY_COMPACTION_SUMMARY_PREFIX) ||
    normalized.startsWith(MODEL_HANDOFF_SUMMARY_PREFIX)
  );
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

/** Preserve the message's own timestamp on epoch rows so replay is byte-stable. */
function piMessageTimestamp(message: PiMessage): number {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" ? timestamp : Date.now();
}

interface RetainedUserMessage {
  message: PiMessage;
  sourceIndex: number;
}

/** Build retained user messages for a compacted Pi replacement history. */
function selectRetainedUserMessageEntries(
  messages: PiMessage[],
  maxTokens = RETAINED_USER_MESSAGE_TOKENS,
): RetainedUserMessage[] {
  const selected: RetainedUserMessage[] = [];
  let remaining = maxTokens;

  for (
    let sourceIndex = messages.length - 1;
    sourceIndex >= 0;
    sourceIndex -= 1
  ) {
    const stripped = stripRuntimeTurnContext([messages[sourceIndex]!]);
    const message = stripped[0];
    if (
      !message ||
      (message as { role?: unknown }).role !== "user" ||
      remaining <= 0
    ) {
      continue;
    }

    const text = sanitizeText(messageText(message));
    if (!text || isCompactionSummary(text) || isPayloadHeavy(text)) {
      continue;
    }

    const tokens = estimateTextTokens(text);
    if (tokens <= remaining) {
      selected.push({ message: userMessage(text), sourceIndex });
      remaining -= tokens;
      continue;
    }

    const truncated = truncateToTokenBudget(text, remaining);
    if (truncated) {
      selected.push({ message: userMessage(truncated), sourceIndex });
    }
    break;
  }

  return selected.reverse();
}

/** Build retained user messages for a compacted Pi replacement history. */
export function selectRetainedUserMessages(
  messages: PiMessage[],
  maxTokens = RETAINED_USER_MESSAGE_TOKENS,
): PiMessage[] {
  return selectRetainedUserMessageEntries(messages, maxTokens).map(
    (entry) => entry.message,
  );
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

/** Ask the fast model for a bounded continuation summary of durable context. */
async function summarizeContext(
  args: {
    conversationContext?: string;
    piMessages: PiMessage[];
    metadata?: CompactContextArgs["metadata"];
    signal?: AbortSignal;
  },
  deps: ContextCompactorDeps,
): Promise<string> {
  const source = renderSummaryInput(args.piMessages, args.conversationContext);
  const result = await deps.completeText({
    modelId: botConfig.fastModelId,
    messageAttributeMode: "metadata",
    temperature: 0,
    signal: args.signal,
    messages: [
      {
        role: "user",
        content: [
          "You are performing a CONTEXT CHECKPOINT COMPACTION for Junior.",
          "Create a concise continuation summary for the agent that will continue this Slack thread.",
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
      actorId: args.metadata?.actorId ?? "",
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

/**
 * Preserve each retained user message's original instruction author by using
 * the retained source projection index; the synthetic compaction summary is
 * always unauthored context.
 */
function buildReplacementProvenance(args: {
  retained: RetainedUserMessage[];
  sourceProvenance: PiMessageProvenance[];
}): PiMessageProvenance[] {
  return [
    ...args.retained.map(
      (entry) => args.sourceProvenance[entry.sourceIndex] ?? contextProvenance,
    ),
    contextProvenance,
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
        slackUserId: args.metadata?.actorId,
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
 * Open the compaction context epoch so later turns read only the replacement
 * history, not the pre-compaction runtime transcript.
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
  const stepStore = getAgentStepStore();
  const sourceProjection = await loadConversationProjection({
    conversationId: args.conversationId,
  });
  const retained = selectRetainedUserMessageEntries(
    trimTrailingAssistantMessages(sourceProjection.messages),
  );
  const replacement = [
    ...retained.map((entry) => entry.message),
    userMessage(`${COMPACTION_SUMMARY_PREFIX}\n${summary}`),
  ];
  // Provenance comes from the committed projection so retained user asks keep
  // their original instruction author across the compaction epoch.
  const replacementProvenance = buildReplacementProvenance({
    retained,
    sourceProvenance: sourceProjection.provenance,
  });
  await stepStore.startEpoch(args.conversationId, {
    reason: "compaction",
    modelProfile: sourceProjection.modelProfile,
    modelId: modelIdForProfile(botConfig, sourceProjection.modelProfile),
    messages: replacement.map((message, index) => ({
      message,
      createdAtMs: piMessageTimestamp(message),
      provenance: replacementProvenance[index]!,
    })),
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

/** Compact the active conversation and durably bind its selected handoff profile. */
export async function compactContextForHandoff(
  args: HandoffContextArgs,
  deps: Pick<ContextCompactorDeps, "completeText">,
): Promise<PiMessage[]> {
  const runtimeMessage = args.runtimeContext.at(-1) as
    | { content: unknown[] }
    | undefined;
  if (!runtimeMessage) {
    throw new Error("Handoff requires the current runtime turn context");
  }
  const summary = `${MODEL_HANDOFF_SUMMARY_PREFIX}\n${await summarizeContext(args, deps)}`;
  const message = {
    ...runtimeMessage,
    content: [
      ...runtimeMessage.content,
      { type: "text", text: renderCurrentInstruction(summary) },
    ],
  } as PiMessage;
  const messages = [message];
  args.signal?.throwIfAborted();
  await getAgentStepStore().startEpoch(args.conversationId, {
    reason: "handoff",
    modelProfile: args.target.modelProfile,
    modelId: args.target.modelId,
    messages: [
      {
        message,
        createdAtMs: piMessageTimestamp(message),
        provenance: contextProvenance,
      },
    ],
  });
  return messages;
}
