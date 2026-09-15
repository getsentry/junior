/**
 * Context compaction.
 *
 * This module bounds visible Pi history for long conversations. It strips
 * runtime-only turn context before summarizing and opens replacement epochs in
 * the durable event store. Capacity compaction retains recent user intent;
 * handoff starts a profile-bound epoch with only its summary. Normal checkpoints
 * may later append the current bootstrap; future replacement strips it again.
 */
import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
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
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { logWarn, setSpanAttributes } from "@/chat/logging";
import {
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import {
  historyItemFromPiMessage,
  piMessageFromHistoryItem,
} from "@/chat/pi/conversation-events";
import { modelIdForProfile, type ModelProfile } from "@/chat/model-profile";
import {
  ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryText,
  MODEL_HANDOFF_SUMMARY_PREFIX,
} from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import {
  findVisibleAgentsInstructions,
  renderAgentsInstructions,
} from "@/chat/repository-instructions";

const RETAINED_USER_MESSAGE_TOKENS = 20_000;
const MAX_SUMMARY_CHARS = 6_000;

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
  onCompactionStart?: () => void | Promise<void>;
  piMessages: PiMessage[];
  metadata?: {
    channelId?: string;
    actorId?: string;
    runId?: string;
    threadId?: string;
  };
  modelId: string;
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
  triggeringToolCallId?: string;
  target: {
    modelId: string;
    modelProfile: ModelProfile;
    reasoningLevel?: string;
  };
}

interface ActiveContextCompactionArgs {
  conversationContext?: string;
  conversationId: string;
  metadata?: CompactContextArgs["metadata"];
  modelId: string;
  modelProfile: ModelProfile;
  onCompactionStart?: () => void | Promise<void>;
  pendingMessages?: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
  }>;
  piMessages: PiMessage[];
  runtimeContextMessages?: PiMessage[];
  signal?: AbortSignal;
}

/** Raised when Junior cannot compact history below the active model's hard ceiling. */
export class ContextInputLimitExceededError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly inputLimitTokens: number,
  ) {
    super(
      `Agent context is ${estimatedTokens} estimated input tokens, above the ${inputLimitTokens} token limit`,
    );
    this.name = "ContextInputLimitExceededError";
  }
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

/** Render Pi message text for retained user-message selection. */
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
  return isCompactionSummaryText(text);
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

function userMessageContent(message: PiMessage): unknown[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function hasTurnBootstrap(message: PiMessage): boolean {
  return userMessageContent(message).some(
    (part) => textPart(part)?.startsWith(`<${TURN_CONTEXT_TAG}>`) === true,
  );
}

function effectiveRuntimeContext(messages: PiMessage[]): {
  content: unknown[];
  timestamp: number;
} {
  let latestBootstrapIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (hasTurnBootstrap(messages[index]!)) {
      latestBootstrapIndex = index;
      break;
    }
  }
  const effectiveMessages =
    latestBootstrapIndex < 0 ? messages : messages.slice(latestBootstrapIndex);
  const allContent = effectiveMessages.flatMap(userMessageContent);
  const firstAgentsIndex = allContent.findIndex(
    (part) => textPart(part)?.startsWith("# AGENTS.md instructions") === true,
  );
  const content = allContent.filter(
    (part) => textPart(part)?.startsWith("# AGENTS.md instructions") !== true,
  );
  const visibleAgents = findVisibleAgentsInstructions(effectiveMessages);
  if (visibleAgents?.active === true) {
    const insertionIndex =
      firstAgentsIndex < 0
        ? content.length
        : Math.min(firstAgentsIndex, content.length);
    content.splice(insertionIndex, 0, {
      type: "text",
      text: renderAgentsInstructions({
        directory: visibleAgents.directory,
        text: visibleAgents.text,
      }),
    });
  }
  const latestTimestamp = (
    effectiveMessages.at(-1) as { timestamp?: unknown } | undefined
  )?.timestamp;
  return {
    content,
    timestamp:
      typeof latestTimestamp === "number" ? latestTimestamp : Date.now(),
  };
}

function runtimeContextMessage(
  messages: PiMessage[],
  timestamp?: number,
): PiMessage | undefined {
  const runtimeContext = effectiveRuntimeContext(messages);
  if (runtimeContext.content.length === 0) {
    return undefined;
  }
  return {
    role: "user",
    content: runtimeContext.content,
    timestamp: timestamp ?? runtimeContext.timestamp,
  } as PiMessage;
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
  const instructions = [
    "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
    "",
    "Include:",
    "- Current progress and key decisions made",
    "- Important context, constraints, or user preferences",
    "- What remains to be done (clear next steps)",
    "- Any critical data, examples, or references needed to continue",
    "",
    "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
  ].join("\n");
  const visibleContext = args.conversationContext?.trim();
  const labeledContext = visibleContext
    ? `<visible-thread-context>\n${visibleContext}\n</visible-thread-context>`
    : undefined;
  const history = stripRuntimeTurnContext(args.piMessages).filter(
    (message): message is Message =>
      ["user", "assistant", "toolResult"].includes(
        (message as { role?: unknown }).role as string,
      ),
  );
  const result = await deps.completeText({
    modelId: botConfig.fastModelId,
    messageAttributeMode: "metadata",
    temperature: 0,
    signal: args.signal,
    promptName: "junior.context_compaction",
    messages: [
      ...history,
      ...(labeledContext ? [userMessage(labeledContext) as Message] : []),
      userMessage(instructions) as Message,
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

/** Measure provider-visible history without counting host-only message fields. */
function estimateHistoryTokens(messages: PiMessage[]): number {
  return estimateContextTokens(messages).tokens;
}

/**
 * Preserve each retained user message's original instruction author by using
 * the retained source projection index; the synthetic compaction summary is
 * always unauthored context.
 */
function buildReplacementProvenance(args: {
  retained: RetainedUserMessage[];
  sourceProvenance: ConversationMessageProvenance[];
}): ConversationMessageProvenance[] {
  return [
    ...args.retained.map((entry) => {
      const provenance = args.sourceProvenance[entry.sourceIndex];
      if (!provenance) {
        throw new Error("retained message provenance is missing");
      }
      return provenance;
    }),
    contextProvenance,
  ];
}

async function loadLastInstruction(conversationId: string) {
  const event =
    await getConversationEventStore().loadLatestInstruction(conversationId);
  if (!event) return undefined;
  if (event.data.type === "user_message") {
    if (event.data.provenance.authority !== "instruction") return undefined;
    return {
      message: piMessageFromHistoryItem(event.data),
      provenance: event.data.provenance,
      sourceEventSeq: event.seq,
    };
  }
  return undefined;
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
    getAgentContextCompactionTriggerTokens(args.modelId);
  if (source.estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }

  await args.onCompactionStart?.();

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
    logWarn("context_compaction.summary.failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return { compacted: false, reason: "summary_failed" };
  }

  return await writeCompactedThreadContext(args, source.messages, summary, {
    estimatedTokens: source.estimatedTokens,
    triggerTokens,
    inputLimitTokens: getAgentContextInputLimitTokens(args.modelId),
  });
}

/**
 * Replace active agent history so later turns read the compacted history, not
 * the pre-compaction runtime transcript.
 */
async function writeCompactedThreadContext(
  args: CompactContextArgs,
  sourceMessages: PiMessage[],
  summary: string,
  context: {
    estimatedTokens: number;
    triggerTokens?: number;
    inputLimitTokens: number;
  },
): Promise<CompactContextResult> {
  const eventStore = getConversationEventStore();
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
  const replacementInputTokens = estimateHistoryTokens(replacement);
  // Provenance comes from the committed projection so retained user asks keep
  // their original instruction author across the compaction epoch.
  const replacementProvenance = buildReplacementProvenance({
    retained,
    sourceProvenance: sourceProjection.provenance,
  });
  await eventStore.replaceHistory(args.conversationId, {
    createdAtMs: Date.now(),
    data: {
      type: "compaction",
      modelProfile: sourceProjection.modelProfile,
      modelId: modelIdForProfile(botConfig, sourceProjection.modelProfile),
      details: {
        reason: "capacity",
        estimatedInputTokens: context.estimatedTokens,
        replacementInputTokens,
        triggerTokens:
          context.triggerTokens ??
          getAgentContextCompactionTriggerTokens(args.modelId),
        inputLimitTokens: context.inputLimitTokens,
        inputMessageCount: sourceMessages.length,
        retainedMessageCount: replacement.length - 1,
        summaryChars: summary.length,
      },
      summary,
      replacementHistory: replacement.map((message, index) => {
        const sourceEventSeq =
          index < retained.length
            ? sourceProjection.seqs[retained[index]!.sourceIndex]
            : undefined;
        return {
          item: historyItemFromPiMessage(
            message,
            replacementProvenance[index]!,
          ),
          ...(sourceEventSeq === undefined ? undefined : { sourceEventSeq }),
        };
      }),
    },
  });

  setSpanAttributes({
    "app.compaction.input_messages": sourceMessages.length,
    "app.compaction.retained_messages": replacement.length - 1,
    "app.compaction.summary_chars": summary.length,
    ...(context.triggerTokens !== undefined
      ? { "app.compaction.trigger_tokens": context.triggerTokens }
      : undefined),
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
  const contextMessage = runtimeContextMessage(args.runtimeContext);
  if (!contextMessage) {
    throw new Error("Handoff requires the current runtime turn context");
  }
  const generatedSummary = await summarizeContext(args, deps);
  const summary = `${MODEL_HANDOFF_SUMMARY_PREFIX}\n${generatedSummary}`;
  const instructionMessage = {
    role: "user",
    content: [{ type: "text", text: renderCurrentInstruction(summary) }],
    timestamp: (contextMessage as { timestamp?: number }).timestamp,
  } as PiMessage;
  const messages = [contextMessage, instructionMessage];
  const replacementMessages = stripRuntimeTurnContext(messages);
  args.signal?.throwIfAborted();
  await getConversationEventStore().replaceHistory(args.conversationId, {
    createdAtMs: Date.now(),
    data: {
      type: "handoff",
      modelProfile: args.target.modelProfile,
      modelId: args.target.modelId,
      ...(args.target.reasoningLevel
        ? { reasoningLevel: args.target.reasoningLevel }
        : undefined),
      ...(args.triggeringToolCallId
        ? { triggeringToolCallId: args.triggeringToolCallId }
        : undefined),
      summary: generatedSummary,
      replacementHistory: replacementMessages.map((replacementMessage) => ({
        item: historyItemFromPiMessage(replacementMessage, contextProvenance),
      })),
    },
  });
  return messages;
}

/**
 * Replace oversized active history at Pi's next-turn boundary before another
 * provider request can observe it.
 */
export async function compactActiveContextIfNeeded(
  args: ActiveContextCompactionArgs,
  deps: Pick<ContextCompactorDeps, "completeText">,
): Promise<CompactContextResult> {
  const pendingMessages = args.pendingMessages ?? [];
  const source = loadCompactionSource([
    ...args.piMessages,
    ...pendingMessages.map((entry) => entry.message),
  ]);
  if ("reason" in source) {
    return { compacted: false, reason: source.reason };
  }
  const triggerTokens = getAgentContextCompactionTriggerTokens(args.modelId);
  if (source.estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }

  await args.onCompactionStart?.();

  const inputLimitTokens = getAgentContextInputLimitTokens(args.modelId);
  let summary: string;
  try {
    summary = await summarizeContext(
      {
        ...args,
        piMessages: args.piMessages,
      },
      deps,
    );
  } catch (error) {
    if (source.estimatedTokens >= inputLimitTokens) {
      throw new ContextInputLimitExceededError(
        source.estimatedTokens,
        inputLimitTokens,
      );
    }
    logWarn("context_compaction.active.summary.failed", {
      "app.context_input_limit_tokens": inputLimitTokens,
      "app.context_tokens_estimated": source.estimatedTokens,
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
    return { compacted: false, reason: "summary_failed" };
  }

  const summaryMessage = userMessage(
    `${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\n${summary}`,
  );
  const retainedInstruction =
    pendingMessages.length === 0
      ? await loadLastInstruction(args.conversationId)
      : undefined;
  const instructionMessages = retainedInstruction
    ? [retainedInstruction.message]
    : pendingMessages.map((entry) => entry.message);
  const instructionProvenance = retainedInstruction
    ? [retainedInstruction.provenance]
    : pendingMessages.map((entry) => entry.provenance);
  const instructionTimestamp = (
    instructionMessages[0] as { timestamp?: unknown } | undefined
  )?.timestamp;
  const retainedRuntimeContext = retainRuntimeTurnContext(
    args.runtimeContextMessages ?? args.piMessages,
  );
  const contextMessage = runtimeContextMessage(
    retainedRuntimeContext,
    typeof instructionTimestamp === "number" ? instructionTimestamp : undefined,
  );
  const replacement = [
    ...(contextMessage
      ? [{ message: contextMessage, provenance: contextProvenance }]
      : []),
    ...instructionMessages.map((message, index) => ({
      message,
      provenance: instructionProvenance[index]!,
      ...(index === 0 && retainedInstruction
        ? { sourceEventSeq: retainedInstruction.sourceEventSeq }
        : undefined),
    })),
    { message: summaryMessage, provenance: contextProvenance },
  ];
  const messages = replacement.map((entry) => entry.message);
  const replacementInputTokens = estimateHistoryTokens(messages);
  if (replacementInputTokens >= inputLimitTokens) {
    throw new ContextInputLimitExceededError(
      replacementInputTokens,
      inputLimitTokens,
    );
  }
  args.signal?.throwIfAborted();
  await getConversationEventStore().replaceHistory(args.conversationId, {
    createdAtMs: Date.now(),
    data: {
      type: "compaction",
      modelProfile: args.modelProfile,
      modelId: args.modelId,
      details: {
        reason: "capacity",
        estimatedInputTokens: source.estimatedTokens,
        replacementInputTokens,
        triggerTokens,
        inputLimitTokens,
        inputMessageCount: source.messages.length,
        retainedMessageCount: instructionMessages.length,
        summaryChars: summary.length,
      },
      summary,
      replacementHistory: replacement.map((entry) => ({
        item: historyItemFromPiMessage(entry.message, entry.provenance),
        ...(entry.sourceEventSeq === undefined
          ? undefined
          : { sourceEventSeq: entry.sourceEventSeq }),
      })),
    },
  });
  setSpanAttributes({
    "app.compaction.input_messages": source.messages.length,
    "app.compaction.replacement_tokens": replacementInputTokens,
    "app.compaction.retained_messages": instructionMessages.length,
    "app.compaction.summary_chars": summary.length,
    "app.compaction.trigger_tokens": triggerTokens,
    "app.context_input_limit_tokens": inputLimitTokens,
    "app.context_tokens_estimated": source.estimatedTokens,
  });
  return { compacted: true, piMessages: messages };
}
