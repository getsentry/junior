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
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import type { ContextSummary } from "@/chat/agent/context-summary";
import {
  calculateContextCompactionTargetTokens,
  getAgentContextCompactionTriggerTokens,
  getAgentContextInputLimitTokens,
} from "@/chat/services/context-budget";
import {
  estimateMessagesTokens,
  estimateTextTokens,
  textCharsForTokens,
} from "@/chat/services/token-estimate";
import {
  contextProvenance,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";
import { loadConversationProjection } from "@/chat/conversations/projection";
import { getConversationEventStore } from "@/chat/db";
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
  hasCompactedConversationContext,
  isCompactionSummaryText,
} from "@/chat/services/context-compaction-marker";
import {
  REQUEST_CONTEXT_SECTION_TAG,
  SESSION_CONTEXT_SECTION_TAG,
  TURN_CONTEXT_TAG,
} from "@/chat/turn-context-tag";
import {
  findVisibleAgentsInstructions,
  renderAgentsInstructions,
} from "@/chat/repository-instructions";
import { appendOpenPlan } from "@/chat/services/plan-continuation";
import {
  withCompactionSpan,
  type CompactionMode,
} from "@/chat/services/context-compaction-telemetry";
import { escapeXml } from "@/chat/xml";

const RETAINED_USER_MESSAGE_TOKENS = 20_000;

/** Outcome of one compaction attempt. */
export interface CompactContextResult {
  compacted: boolean;
  piMessages?: PiMessage[];
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
  modelId: string;
  onCompactionStart?: () => void | Promise<void>;
  pendingMessages?: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
  }>;
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
  signal?: AbortSignal;
  /** Index in the runtime context messages where the current Turn starts. */
  turnStartMessageIndex?: number;
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

function isSessionTurnContext(text: string | undefined): text is string {
  return (
    text?.startsWith(`<${TURN_CONTEXT_TAG}>`) === true &&
    text.includes(`\n<${SESSION_CONTEXT_SECTION_TAG}>\n`)
  );
}

/** Remove the sections that only the Turn that received them can use. */
function withoutRequestContext(text: string): string {
  return Object.values(REQUEST_CONTEXT_SECTION_TAG).reduce(
    (result, tag) =>
      result.replace(
        new RegExp(`\\n\\n<${tag}>\\n[\\s\\S]*?\\n</${tag}>`, "g"),
        "",
      ),
    text,
  );
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
      } as PiMessage;
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
  const content = allContent.filter(
    (part) => textPart(part)?.startsWith("# AGENTS.md instructions") !== true,
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
  turnStartMessageIndex: number | undefined,
  timestamp?: number,
): PiMessage | undefined {
  if (turnStartMessageIndex === undefined) {
    return runtimeContextMessage(retainRuntimeTurnContext(messages), timestamp);
  }
  const earlierContext = retainRuntimeTurnContext(
    messages.slice(0, turnStartMessageIndex),
  );
  const turnContext = retainRuntimeTurnContext(
    messages.slice(turnStartMessageIndex),
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
 * does not carry: the latest session context and the AGENTS.md
 * instructions. Request context of earlier Turns is left out.
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

/** Keep generated text inside the existing evidence-only prompt boundary. */
export function renderCompactionSummary(summary: string): string {
  return [
    COMPACTION_SUMMARY_PREFIX,
    '<thread-context authority="evidence-only">',
    escapeXml(summary),
    "</thread-context>",
  ].join("\n");
}

function timestampOf(message: PiMessage): number | undefined {
  const { timestamp } = message as { timestamp?: unknown };
  return typeof timestamp === "number" ? timestamp : undefined;
}

/** Find the latest compaction summary in history. */
function latestSummaryIndex(messages: PiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      (message as { role?: unknown }).role === "user" &&
      hasCompactedConversationContext([message])
    ) {
      return index;
    }
  }
  return -1;
}

/** Find when the latest compaction summary in history was written. */
function latestSummaryTimestamp(messages: PiMessage[]): number | undefined {
  const index = latestSummaryIndex(messages);
  return index < 0 ? undefined : timestampOf(messages[index]!);
}

/**
 * Read the input size that the provider reported for one model call. Output
 * is left out: it is not part of the request that the call measured.
 */
function measuredInputTokens(message: PiMessage): number | undefined {
  const { role, stopReason, usage } = message as {
    role?: unknown;
    stopReason?: unknown;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
  };
  if (
    role !== "assistant" ||
    !usage ||
    stopReason === "aborted" ||
    stopReason === "error"
  ) {
    return undefined;
  }
  const tokens =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return tokens > 0 ? tokens : undefined;
}

/**
 * Measure provider-visible history without counting host-only message fields.
 *
 * Provider usage counts the request that produced it. A replacement keeps
 * assistant messages that are older than its summary, and their usage counts
 * the history before the replacement. So when the latest usage is older than
 * the latest summary, estimate each message by size.
 */
export function estimateHistoryTokens(
  messages: PiMessage[],
  modelId: string,
  requestOverheadTokens = 0,
): number {
  const estimate = estimateContextTokens(messages);
  const summaryAt = latestSummaryTimestamp(messages);
  const usageAt =
    estimate.lastUsageIndex === null
      ? undefined
      : timestampOf(messages[estimate.lastUsageIndex]!);
  if (
    estimate.lastUsageIndex !== null &&
    usageAt !== undefined &&
    (summaryAt === undefined || usageAt > summaryAt)
  ) {
    // The usage counts the request up to that call. Estimate the rest by size.
    return (
      estimate.usageTokens +
      estimateMessagesTokens(
        messages.slice(estimate.lastUsageIndex + 1),
        modelId,
      )
    );
  }
  return estimateReplacementTokens(messages, modelId, requestOverheadTokens);
}

/**
 * Read the provider-reported input of the first model call after the latest
 * full compaction. That request held only the summary and the kept context,
 * so another full compaction of the same context cannot get much below it.
 * A swap also keeps agent history from before its summary. A full compaction
 * can still drop that history, so a swap gives no such size.
 */
function measuredReplacementTokens(messages: PiMessage[]): number | undefined {
  const summaryIndex = latestSummaryIndex(messages);
  if (summaryIndex < 0) return undefined;
  const summaryAt = timestampOf(messages[summaryIndex]!);
  if (summaryAt === undefined) return undefined;
  for (const message of messages.slice(summaryIndex + 1)) {
    const timestamp = timestampOf(message);
    if (timestamp === undefined || timestamp <= summaryAt) {
      if ((message as { role?: unknown }).role !== "user") return undefined;
      continue;
    }
    const tokens = measuredInputTokens(message);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

/**
 * Estimate a replacement request from each message's own size. A kept
 * assistant message holds provider usage for the whole request before the
 * replacement, so usage is ignored here.
 */
export function estimateReplacementTokens(
  messages: PiMessage[],
  modelId: string,
  requestOverheadTokens = 0,
): number {
  return requestOverheadTokens + estimateMessagesTokens(messages, modelId);
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
    args.turnStartMessageIndex,
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
  const keptTokens = estimateReplacementTokens(
    [...retainedUserMessages, ...contextEntries, ...instructionEntries].map(
      (entry) => entry.message,
    ),
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
      appendOpenPlan(renderCompactionSummary(summary), source.messages),
    ),
    provenance: contextProvenance,
  };
  const replacement: Array<{
    message: PiMessage;
    provenance: ConversationMessageProvenance;
    sourceEventSeq?: number;
  }> = retainUserMessages
    ? [
        ...retainedUserMessages,
        summaryEntry,
        ...contextEntries,
        ...instructionEntries,
      ]
    : [...contextEntries, ...instructionEntries, summaryEntry];
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
  await getConversationEventStore().replaceHistory(args.conversationId, {
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
  });
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
  return { compacted: true, piMessages: messages };
}
