/**
 * Context compaction.
 *
 * Bounds Pi history for long conversations and commits a history
 * replacement. Capacity compaction gets its summary from the caller, which
 * asks the agent model with the cached request prefix. Mid-turn replacements
 * keep the authored instruction before the summary. Turn-start replacements keep recent user
 * messages, the summary, then the new instruction. Checkpoints can append
 * fresh runtime context; the next replacement removes it again.
 */
import {
  escapeTagTextAndQuotes,
  findTag,
  startsWithTag,
  stripTags,
} from "@sentry/junior-plugin-api";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import { renderThreadContext } from "@/chat/input-tags";
import type { PiMessage } from "@/chat/pi/messages";
import {
  type SystemSections,
  systemSectionsChange,
} from "@/chat/pi/agent-history";
import type { ContextSummary } from "@/chat/agent/context-summary";
import {
  calculateContextCompactionTargetTokens,
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import {
  estimateTextTokens,
  textCharsForTokens,
} from "@/chat/services/token-estimate";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
import type { HistoryReplacementResult } from "@/chat/conversations/history";
import { logWarn, setSpanAttributes } from "@/chat/logging";
import {
  isStandaloneRuntimeContextMessage,
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
  trimTrailingAssistantMessages,
} from "@/chat/pi/transcript";
import {
  historyItemFromPiMessage,
  piMessageFromHistoryItem,
} from "@/chat/pi/conversation-events";
import {
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryText,
} from "@/chat/services/context-compaction-marker";
import {
  CAPABILITY_SECTION_TAG,
  REQUEST_CONTEXT_SECTION_TAG,
  SESSION_CONTEXT_SECTION_TAG,
  TURN_CONTEXT_TAG,
} from "@/chat/turn-context-tag";
import {
  findVisibleAgentsInstructions,
  renderAgentsInstructions,
} from "@/chat/repository-instructions";
import { appendTodosSnapshot } from "@/chat/todos/snapshot";
import { TODO_DELTA_TAG } from "@/chat/todos/prompt";
import {
  withCompactionSpan,
  type CompactionMode,
} from "@/chat/services/context-compaction-telemetry";
import {
  estimateHistoryTokens,
  estimateReplacementTokens,
  measuredReplacementTokens,
} from "@/chat/services/context-compaction-tokens";

const RETAINED_USER_MESSAGE_TOKENS = 20_000;

/** Outcome of one compaction attempt. */
export interface CompactContextResult {
  compacted: boolean;
  piMessages?: PiMessage[];
  /**
   * Event seq of each replacement message: its source seq when it kept one,
   * otherwise the seq of the compaction event.
   */
  piMessageSeqs?: number[];
  reason?:
    | "below_threshold"
    | "deferred"
    | "history_conflict"
    | "missing_context"
    | "over_input_limit"
    | "over_target"
    | "summary_failed";
}

/** Inputs of a capacity compaction or a prepared-summary swap. */
export interface ActiveContextCompactionArgs {
  conversationId: string;
  /**
   * The Conversation's leading capability sections, part of the system
   * prompt. None before the first Turn that saves them.
   */
  leadingSystemSections?: SystemSections | undefined;
  modelId: string;
  onCompactionStart?: () => void | Promise<void>;
  pendingMessages?:
    | Array<{
        message: PiMessage;
        provenance: ConversationMessageProvenance;
      }>
    | undefined;
  piMessages: PiMessage[];
  /**
   * `blocking` runs before the first model request of a Turn. With a new
   * instruction, it keeps recent user messages from committed history before
   * the summary. `active` runs between model calls and keeps only the
   * instruction.
   */
  mode: CompactionMode;
  /**
   * Estimated tokens of the system prompt and tool definitions. Provider
   * usage counts them, so a replacement estimate must count them too.
   */
  requestOverheadTokens?: number;
  runtimeContextMessages?: PiMessage[];
  signal?: AbortSignal | undefined;
  /** True when the runtime context message at `index` belongs to this Turn. */
  isTurnMessage?:
    | ((messages: readonly PiMessage[], index: number) => boolean)
    | undefined;
}

/** Raised when Junior cannot compact history below the active model's hard ceiling. */
export class ContextInputLimitExceededError extends Error {
  readonly estimatedTokens: number;
  readonly inputLimitTokens: number;

  constructor(estimatedTokens: number, inputLimitTokens: number) {
    super(
      `Agent context is ${estimatedTokens} estimated input tokens, above the ${inputLimitTokens} token limit`,
    );
    this.estimatedTokens = estimatedTokens;
    this.inputLimitTokens = inputLimitTokens;
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
  return (
    text
      // Provider tool output, not a Junior prompt tag: redact its payload.
      .replace(
        // oxlint-disable-next-line junior/no-prompt-tag-matching
        /<data_base64>[\s\S]*?<\/data_base64>/g,
        // oxlint-disable-next-line junior/no-hand-built-prompt-tags
        "<data_base64>[omitted]</data_base64>",
      )
      .replace(
        /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi,
        "[image data omitted]",
      )
      .replaceAll("\u0000", " ")
      .trim()
  );
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, textCharsForTokens(maxTokens));
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function isCompactionSummary(text: string): boolean {
  return isCompactionSummaryText(text);
}

function isPayloadHeavy(text: string): boolean {
  // oxlint-disable-next-line junior/no-prompt-tag-matching -- provider payload, as in sanitizeText
  return /<data_base64>[\s\S]*?<\/data_base64>|data:image\/[a-z0-9.+-]+;base64,/i.test(
    text,
  );
}

/** Build a text-only user message for a replacement history. */
export function userMessage(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function userMessageContent(message: PiMessage): unknown[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function hasTurnBootstrap(message: PiMessage): boolean {
  return userMessageContent(message).some((part) =>
    isTurnContextText(textPart(part)),
  );
}

function isSessionTurnContext(text: string | undefined): text is string {
  return (
    isTurnContextText(text) &&
    findTag(text, SESSION_CONTEXT_SECTION_TAG) !== undefined
  );
}

function isTurnContextText(text: string | undefined): text is string {
  return text !== undefined && startsWithTag(text, [TURN_CONTEXT_TAG]);
}

/**
 * Remove the sections that only the Turn that received them can use, and
 * To-do deltas, which the `<todos>` snapshot of the summary replaces.
 */
function withoutRequestContext(text: string): string {
  return stripTags(text, [
    ...Object.values(REQUEST_CONTEXT_SECTION_TAG),
    TODO_DELTA_TAG,
  ]);
}

/**
 * Remove the copies of capability sections that the Turn context of older
 * Turns held. The leading sections and later system messages hold them now,
 * and compaction keeps their changes.
 */
function withoutCapabilitySections(content: unknown[]): unknown[] {
  return content.map((part) => {
    const text = textPart(part);
    return isTurnContextText(text)
      ? {
          ...(part as object),
          text: stripTags(text, Object.values(CAPABILITY_SECTION_TAG)),
        }
      : part;
  });
}

/** Find the latest session context and keep only its session sections. */
function latestSessionContext(messages: PiMessage[]): PiMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const text = userMessageContent(message)
      .map(textPart)
      .find(isSessionTurnContext);
    if (text) {
      return {
        ...message,
        content: [{ type: "text", text: withoutRequestContext(text) }],
      };
    }
  }
  return undefined;
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
  return runtimeContextContent(effectiveMessages, effectiveMessages);
}

function runtimeContextContent(
  messages: PiMessage[],
  agentsMessages: PiMessage[],
): {
  content: unknown[];
  timestamp: number;
} {
  const allContent = messages.flatMap(userMessageContent);
  const firstAgentsIndex = allContent.findIndex(
    (part) => textPart(part)?.startsWith("# AGENTS.md instructions") === true,
  );
  const content = withoutCapabilitySections(
    allContent.filter(
      (part) => textPart(part)?.startsWith("# AGENTS.md instructions") !== true,
    ),
  );
  const visibleAgents = findVisibleAgentsInstructions(agentsMessages);
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
    messages.at(-1) as { timestamp?: unknown } | undefined
  )?.timestamp;
  return {
    content,
    timestamp:
      typeof latestTimestamp === "number" ? latestTimestamp : Date.now(),
  };
}

function toRuntimeContextMessage(
  runtimeContext: { content: unknown[]; timestamp: number },
  timestamp?: number,
): PiMessage | undefined {
  if (runtimeContext.content.length === 0) {
    return undefined;
  }
  return {
    role: "user",
    content: runtimeContext.content,
    timestamp: timestamp ?? runtimeContext.timestamp,
  } as PiMessage;
}

function runtimeContextMessage(
  messages: PiMessage[],
  timestamp?: number,
): PiMessage | undefined {
  return toRuntimeContextMessage(effectiveRuntimeContext(messages), timestamp);
}

/**
 * Build the runtime context that the current Turn can use after an in-turn
 * replacement.
 *
 * Request context, such as plugin context and disabled tools, is true only for
 * the Turn that received it. From earlier Turns, keep only the latest session
 * context and AGENTS.md instructions.
 */
function turnRuntimeContextMessage(
  messages: PiMessage[],
  isTurnMessage:
    | ((messages: readonly PiMessage[], index: number) => boolean)
    | undefined,
  timestamp?: number,
): PiMessage | undefined {
  if (!isTurnMessage) {
    return runtimeContextMessage(retainRuntimeTurnContext(messages), timestamp);
  }
  const earlierContext = retainRuntimeTurnContext(
    messages.filter((_, index) => !isTurnMessage(messages, index)),
  );
  const turnContext = retainRuntimeTurnContext(
    messages.filter((_, index) => isTurnMessage(messages, index)),
  );
  const sessionContext = turnContext.some((message) =>
    userMessageContent(message).map(textPart).some(isSessionTurnContext),
  )
    ? undefined
    : latestSessionContext(earlierContext);
  return toRuntimeContextMessage(
    runtimeContextContent(
      sessionContext ? [sessionContext, ...turnContext] : turnContext,
      [...earlierContext, ...turnContext],
    ),
    timestamp,
  );
}

/**
 * Build the runtime context of summarized history that the kept history
 * does not carry: the latest session context and the AGENTS.md instructions.
 * Request context of earlier Turns is left out.
 */
export function summarizedRuntimeContextMessage(
  summarized: PiMessage[],
  kept: PiMessage[],
): PiMessage | undefined {
  const earlierContext = retainRuntimeTurnContext(summarized);
  const keptContext = retainRuntimeTurnContext(kept);
  const sessionContext = keptContext.some((message) =>
    userMessageContent(message).map(textPart).some(isSessionTurnContext),
  )
    ? undefined
    : latestSessionContext(earlierContext);
  return toRuntimeContextMessage(
    runtimeContextContent(
      sessionContext ? [sessionContext] : [],
      findVisibleAgentsInstructions(kept) ? [] : earlierContext,
    ),
  );
}

interface RetainedUserMessage {
  message: PiMessage;
  sourceIndex: number;
}

/**
 * Build retained user messages for a compacted Pi replacement history. Each
 * entry keeps the index of its source message.
 */
export function selectRetainedUserMessageEntries(
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
    // Check the pair in place: alone, a context message looks like an ask.
    if (isStandaloneRuntimeContextMessage(messages, sourceIndex)) {
      continue;
    }
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

/** Match a message across a durable commit, which can reorder JSON keys. */
function retainedMessageKey(message: PiMessage): string {
  const { role, timestamp } = message as {
    role?: unknown;
    timestamp?: unknown;
  };
  return `${String(role)}:${String(timestamp)}:${messageText(message)}`;
}

/**
 * Load recent user messages from committed history. Each one keeps its
 * original author and source event.
 */
async function loadRetainedUserMessages(
  conversationId: string,
  pendingMessages: PiMessage[],
) {
  const projection = await loadConversationProjection({ conversationId });
  // The Turn can commit its context and new instruction before compaction.
  // They follow the summary, so leave them and everything after them out of
  // the selection.
  const pendingKeys = new Set(pendingMessages.map(retainedMessageKey));
  let pendingStart = projection.messages.findIndex((message) =>
    pendingKeys.has(retainedMessageKey(message)),
  );
  if (
    pendingStart > 0 &&
    isStandaloneRuntimeContextMessage(projection.messages, pendingStart - 1)
  ) {
    pendingStart -= 1;
  }
  const history =
    pendingStart === -1
      ? projection.messages
      : projection.messages.slice(0, pendingStart);
  return selectRetainedUserMessageEntries(
    trimTrailingAssistantMessages(history),
  ).map((entry) => {
    const provenance = projection.provenance[entry.sourceIndex];
    if (!provenance) {
      throw new Error("retained message provenance is missing");
    }
    return {
      message: entry.message,
      provenance,
      sourceEventSeq: projection.seqs[entry.sourceIndex],
    };
  });
}

const COMPACTION_READ_BACK_NOTE =
  "The summary replaced earlier messages and tool results and leaves out most of their details. Before you call a detail unknown or ask for it, search for it with a searchConversationEvents query, then read the full text with readConversationEvent.";

/**
 * Keep generated text inside the existing evidence-only prompt boundary. The
 * last line says where replaced detail stays readable: without it, the model
 * often decides a detail from a compacted tool result is gone, and asks the
 * person for it.
 */
export function renderCompactionSummary(summary: string): string {
  return [
    COMPACTION_SUMMARY_PREFIX,
    renderThreadContext([escapeTagTextAndQuotes(summary)]),
    COMPACTION_READ_BACK_NOTE,
  ].join("\n");
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

function loadCompactionSource(
  messages: PiMessage[],
  modelId: string,
  requestOverheadTokens: number | undefined,
): CompactionSource {
  if (messages.length > 0) {
    return {
      estimatedTokens: estimateHistoryTokens(
        messages,
        modelId,
        requestOverheadTokens,
      ),
      messages,
    };
  }
  return { reason: "missing_context" };
}

/**
 * Replace oversized active history at Pi's next-turn boundary before another
 * provider request can observe it.
 *
 * `summarize` gets the history without pending messages. When it fails, the
 * history stays as it is, unless the history is at the input limit.
 */
export async function compactActiveContextIfNeeded(
  args: ActiveContextCompactionArgs,
  summarize: (
    messages: PiMessage[],
    signal?: AbortSignal,
  ) => Promise<ContextSummary>,
): Promise<CompactContextResult> {
  const pendingMessages = args.pendingMessages ?? [];
  const source = loadCompactionSource(
    [...args.piMessages, ...pendingMessages.map((entry) => entry.message)],
    args.modelId,
    args.requestOverheadTokens,
  );
  if ("reason" in source) {
    return { compacted: false, reason: source.reason };
  }
  const triggerTokens = getAgentContextCompactionTriggerTokens(args.modelId);
  if (source.estimatedTokens <= triggerTokens) {
    return { compacted: false, reason: "below_threshold" };
  }
  return await withCompactionSpan(args.mode, "summary", () =>
    compactActiveAboveThreshold(args, summarize, source, triggerTokens),
  );
}

async function compactActiveAboveThreshold(
  args: ActiveContextCompactionArgs,
  summarize: (
    messages: PiMessage[],
    signal?: AbortSignal,
  ) => Promise<ContextSummary>,
  source: { estimatedTokens: number; messages: PiMessage[] },
  triggerTokens: number,
): Promise<CompactContextResult> {
  const pendingMessages = args.pendingMessages ?? [];
  const retainUserMessages =
    args.mode === "blocking" && pendingMessages.length > 0;
  const inputLimitTokens = getAgentContextInputLimitTokens(args.modelId);
  // `app.compaction.skip_reason`. `over_target`: the kept context is above
  // the target without a summary. `last_over_threshold`: the first model call
  // after the latest full compaction was above the threshold.
  // `over_input_limit`: the kept context is at the input limit, so no summary
  // fits. The first two compact again at the input limit.
  const skip = (
    reason: "last_over_threshold" | "over_input_limit" | "over_target",
  ) => {
    setSpanAttributes({
      "app.compaction.outcome": "skipped",
      "app.compaction.skip_reason": reason,
      "app.compaction.input.estimate": source.estimatedTokens,
      "app.compaction.threshold": triggerTokens,
    });
    return {
      compacted: false,
      reason: reason === "over_input_limit" ? reason : "over_target",
    } as const;
  };
  // A summary replaces only agent history. When the kept context alone stays
  // over the threshold, another summary cannot get under it, and the next
  // model call would compact again. Then compact only at the input limit.
  const belowInputLimit = source.estimatedTokens < inputLimitTokens;
  const measuredTokens = measuredReplacementTokens(source.messages);
  if (
    belowInputLimit &&
    measuredTokens !== undefined &&
    measuredTokens > triggerTokens
  ) {
    return skip("last_over_threshold");
  }

  const retainedInstruction =
    pendingMessages.length === 0 && !retainUserMessages
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
  const contextMessage = turnRuntimeContextMessage(
    args.runtimeContextMessages ?? args.piMessages,
    args.isTurnMessage,
    typeof instructionTimestamp === "number" ? instructionTimestamp : undefined,
  );
  const contextEntries = contextMessage
    ? [{ message: contextMessage, provenance: contextProvenance }]
    : [];
  const instructionEntries = instructionMessages.map((message, index) => ({
    message,
    provenance: instructionProvenance[index]!,
    ...(index === 0 && retainedInstruction
      ? { sourceEventSeq: retainedInstruction.sourceEventSeq }
      : undefined),
  }));
  // At Turn start, earlier asks and the summary come first, then the new
  // Turn's context and instruction, as they would after a normal Turn.
  const retainedUserMessages = retainUserMessages
    ? await loadRetainedUserMessages(args.conversationId, instructionMessages)
    : [];
  const systemMessage = systemSectionsChange(
    args.leadingSystemSections ?? {},
    args.piMessages,
  );
  const systemEntries = systemMessage
    ? [{ message: systemMessage, provenance: contextProvenance }]
    : [];
  const keptTokens = estimateReplacementTokens(
    [
      ...retainedUserMessages,
      ...contextEntries,
      ...instructionEntries,
      ...systemEntries,
    ].map((entry) => entry.message),
    args.modelId,
    args.requestOverheadTokens,
  );
  if (
    belowInputLimit &&
    keptTokens > calculateContextCompactionTargetTokens(triggerTokens)
  ) {
    return skip("over_target");
  }
  // When the kept context alone is at the input limit, no summary can fit.
  // The model request still runs: the provider decides if it fits.
  if (keptTokens >= inputLimitTokens) {
    return skip("over_input_limit");
  }

  await args.onCompactionStart?.();
  let summary: string;
  let costUsd: number | undefined;
  try {
    ({ summary, costUsd } = await summarize(args.piMessages, args.signal));
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
    setSpanAttributes({ "app.compaction.outcome": "summary_failed" });
    return { compacted: false, reason: "summary_failed" };
  }

  const summaryEntry = {
    message: userMessage(
      await appendTodosSnapshot(
        renderCompactionSummary(summary),
        args.conversationId,
      ),
    ),
    provenance: contextProvenance,
  };
  // The section changes directly follow the summary of the history that
  // held them. A system message must follow a user message. Pi sends it
  // right before the next assistant message; the system prompt stays the
  // same.
  const replacement: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
    sourceEventSeq?: number;
  }> = retainUserMessages
    ? [
        ...retainedUserMessages,
        summaryEntry,
        ...systemEntries,
        ...contextEntries,
        ...instructionEntries,
      ]
    : [
        ...contextEntries,
        ...instructionEntries,
        summaryEntry,
        ...systemEntries,
      ];
  const retainedMessageCount =
    retainedUserMessages.length + instructionMessages.length;
  const messages = replacement.map((entry) => entry.message);
  const replacementInputTokens = estimateReplacementTokens(
    messages,
    args.modelId,
    args.requestOverheadTokens,
  );
  if (replacementInputTokens >= inputLimitTokens) {
    throw new ContextInputLimitExceededError(
      replacementInputTokens,
      inputLimitTokens,
    );
  }
  args.signal?.throwIfAborted();
  const result = await getConversationEventStore().replaceHistory(
    args.conversationId,
    {
      createdAtMs: Date.now(),
      data: {
        type: "compaction",
        modelId: args.modelId,
        details: {
          reason: "capacity",
          estimatedInputTokens: source.estimatedTokens,
          replacementInputTokens,
          triggerTokens,
          inputLimitTokens,
          inputMessageCount: source.messages.length,
          retainedMessageCount,
          summaryChars: summary.length,
        },
        ...(costUsd === undefined ? undefined : { costUsd }),
        summary,
        replacementHistory: replacement.map((entry) => ({
          item: historyItemFromPiMessage(entry.message, entry.provenance),
          ...(entry.sourceEventSeq === undefined
            ? undefined
            : { sourceEventSeq: entry.sourceEventSeq }),
        })),
      },
    },
  );
  setSpanAttributes({
    "app.compaction.outcome": "compacted",
    "app.compaction.input_messages": source.messages.length,
    "app.compaction.retained_messages": retainedMessageCount,
    "app.compaction.summary_chars": summary.length,
    "app.compaction.input.estimate": source.estimatedTokens,
    "app.compaction.replacement.estimate": replacementInputTokens,
    "app.compaction.input_limit": inputLimitTokens,
    "app.compaction.threshold": triggerTokens,
  });
  return {
    compacted: true,
    piMessages: messages,
    piMessageSeqs: replacementSeqs(replacement, result),
  };
}

/** The event seq of each replacement entry after `replaceHistory`. */
export function replacementSeqs(
  replacement: readonly { sourceEventSeq?: number | undefined }[],
  result: HistoryReplacementResult,
): number[] {
  if (result.status !== "replaced") {
    throw new Error("A conflicting history replacement has no seqs");
  }
  return replacement.map((entry) => entry.sourceEventSeq ?? result.seq);
}
