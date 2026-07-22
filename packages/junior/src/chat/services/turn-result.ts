import { logInfo, logWarn, summarizeMessageText } from "@/chat/logging";
import type { LogContext } from "@/chat/logging";
import { containsNoReplyMarker, isNoReplyMarker } from "@/chat/no-reply";
import type { PiMessage } from "@/chat/pi/messages";
import type { TurnRoute } from "@/chat/services/turn-router";
import type { AgentTurnUsage } from "@/chat/usage";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  extractAssistantText,
  getTerminalAssistantMessages,
  isAssistantMessage,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";

function isExecutionDeferralResponse(text: string): boolean {
  return /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
    text,
  );
}

function isToolAccessDisclaimerResponse(text: string): boolean {
  return /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
    text,
  );
}

/** True when the model produced an escape response instead of executing. */
function isExecutionEscapeResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    isExecutionDeferralResponse(trimmed) ||
    isToolAccessDisclaimerResponse(trimmed)
  );
}

function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return undefined;
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isToolPayloadShape(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.startsWith("tool-")) return true;
  if (
    type === "tool_use" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "tool_error"
  )
    return true;

  const hasToolName =
    typeof record.toolName === "string" || typeof record.name === "string";
  const hasToolInput =
    Object.prototype.hasOwnProperty.call(record, "input") ||
    Object.prototype.hasOwnProperty.call(record, "args");
  if (hasToolName && hasToolInput) return true;

  return false;
}

/** Detect responses that are raw tool payloads leaked as text. */
function isRawToolPayloadResponse(text: string): boolean {
  const parsed = parseJsonCandidate(text);
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => isToolPayloadShape(entry));
  }
  if (isToolPayloadShape(parsed)) {
    return true;
  }
  return false;
}

const THINKING_XML_BLOCK_PATTERN =
  /[ \t]*<thinking\b[^>]*>[\s\S]*?<\/thinking>[ \t]*(?:\r?\n)?/gi;
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  durationMs?: number;
  errorMessage?: string;
  providerError?: unknown;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  reasoningLevel?: TurnRoute["reasoningLevel"];
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usage?: AgentTurnUsage;
  usedPrimaryText: boolean;
}

export interface AgentRunResult {
  /** Sanitized terminal text for diagnostics and failure fallback, not success delivery. */
  text: string;
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  piMessages?: PiMessage[];
  diagnostics: AgentTurnDiagnostics;
}

export interface TurnResultInput {
  newMessages: unknown[];
  userInput: string;
  artifactStatePatch: Partial<ThreadArtifactsState>;
  toolCalls: string[];
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  piMessages?: PiMessage[];
  durationMs?: number;
  generatedFileCount: number;
  shouldTrace: boolean;
  spanContext: LogContext;
  usage?: AgentTurnUsage;
  executionProfile: TurnRoute;
  assistantUserName?: string;
  modelId: string;
}

function stripThinkingXmlBlocks(text: string): string {
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    result += text.slice(cursor, start).replace(THINKING_XML_BLOCK_PATTERN, "");
    result += match[0];
    cursor = start + match[0].length;
  }

  result += text.slice(cursor).replace(THINKING_XML_BLOCK_PATTERN, "");
  return result;
}

function getVisibleAssistantText(rawText: string): string | undefined {
  const text = stripThinkingXmlBlocks(rawText).trim();
  if (
    !text ||
    isNoReplyMarker(text) ||
    containsNoReplyMarker(text) ||
    isRawToolPayloadResponse(text)
  ) {
    return undefined;
  }
  return text;
}

/** Return destination-visible text from one completed tool-free assistant message. */
export function getAssistantMessageText(
  message: Parameters<typeof extractAssistantText>[0],
): string | undefined {
  if (message.content.some((part) => part.type === "toolCall")) {
    return undefined;
  }
  const text = getVisibleAssistantText(extractAssistantText(message));
  if (!text) {
    return undefined;
  }
  return isExecutionEscapeResponse(text) ? undefined : text;
}

/** Process raw agent messages into a structured AgentRunResult. */
export function buildTurnResult(input: TurnResultInput): AgentRunResult {
  const {
    newMessages,
    artifactStatePatch,
    toolCalls,
    sandboxId,
    sandboxDependencyProfileHash,
    durationMs,
    shouldTrace,
    spanContext,
    usage,
    executionProfile,
    assistantUserName,
    modelId,
  } = input;

  const toolResults = newMessages.filter(isToolResultMessage);
  const assistantMessages = newMessages.filter(isAssistantMessage);
  const terminalAssistantMessages = getTerminalAssistantMessages(newMessages);

  const rawPrimaryText = stripThinkingXmlBlocks(
    terminalAssistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n\n"),
  ).trim();
  const exactNoReplyMarker = isNoReplyMarker(rawPrimaryText);
  const mixedNoReplyMarker =
    !exactNoReplyMarker && containsNoReplyMarker(rawPrimaryText);
  const noReplyRequested = exactNoReplyMarker || mixedNoReplyMarker;
  const primaryText = noReplyRequested
    ? ""
    : terminalAssistantMessages
        .map((message) => getAssistantMessageText(message))
        .filter((text): text is string => Boolean(text))
        .join("\n\n");

  const toolErrorCount = toolResults.filter((result) => result.isError).length;
  const reactionPerformed = toolResults.some(
    (result) =>
      !isToolResultError(result) &&
      normalizeToolNameFromResult(result) === "addReaction",
  );
  const completedWithoutTerminalText = noReplyRequested;
  const resultLogContext = {
    ...spanContext,
    assistantUserName,
    modelId,
  };
  const lastAssistant = terminalAssistantMessages.at(-1) as
    | { stopReason?: unknown; errorMessage?: unknown }
    | undefined;
  const stopReason =
    typeof lastAssistant?.stopReason === "string"
      ? lastAssistant.stopReason
      : undefined;
  const errorMessage =
    typeof lastAssistant?.errorMessage === "string"
      ? lastAssistant.errorMessage
      : undefined;
  const isProviderError = stopReason === "error";

  if (exactNoReplyMarker) {
    const markerCategory = reactionPerformed ? "reaction" : "none";
    const markerContext = resultLogContext;
    const markerAttributes = {
      "app.ai.no_reply_marker": true,
      "app.ai.no_reply_marker_category": markerCategory,
      "app.ai.no_reply_marker_accepted": !isProviderError,
    };

    if (!isProviderError) {
      logInfo(
        "ai_no_reply_marker_accepted",
        markerContext,
        markerAttributes,
        "No-reply marker suppressed visible thread text",
      );
    }
  } else if (mixedNoReplyMarker) {
    logWarn(
      "ai_no_reply_marker_mixed_text",
      resultLogContext,
      {
        "app.ai.no_reply_marker": true,
        "app.ai.no_reply_marker_mode": "mixed",
      },
      "No-reply marker appeared with visible assistant text",
    );
  }

  if (!primaryText && !completedWithoutTerminalText && !isProviderError) {
    logWarn(
      "ai_model_response_empty",
      resultLogContext,
      {
        "app.ai.tool_results": toolResults.length,
        "app.ai.tool_error_results": toolErrorCount,
        "app.ai.generated_files": input.generatedFileCount,
      },
      "Model returned empty text response",
    );
  }

  const usedPrimaryText = Boolean(rawPrimaryText);
  let outcome: AgentTurnDiagnostics["outcome"];
  if (isProviderError) {
    outcome = "provider_error";
  } else if (primaryText || completedWithoutTerminalText) {
    outcome = "success";
  } else {
    outcome = "execution_failure";
  }
  const rejectedPrimaryText = Boolean(
    rawPrimaryText && !noReplyRequested && !primaryText,
  );
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = rejectedPrimaryText
    ? "execution_failure"
    : outcome;

  if (shouldTrace) {
    logInfo(
      "agent_message_out",
      spanContext,
      {
        "app.message.kind": "assistant_outbound",
        "app.message.length": primaryText.length,
        "app.message.output": summarizeMessageText(primaryText),
        "app.ai.outcome": resolvedOutcome,
        "app.ai.assistant_messages": assistantMessages.length,
        ...(stopReason
          ? { "gen_ai.response.finish_reasons": [stopReason] }
          : {}),
      },
      "Agent message sent",
    );
  }

  const resolvedDiagnostics: AgentTurnDiagnostics = {
    outcome: resolvedOutcome,
    modelId,
    assistantMessageCount: assistantMessages.length,
    reasoningLevel: executionProfile.reasoningLevel,
    toolCalls,
    toolResultCount: toolResults.length,
    toolErrorCount,
    usedPrimaryText,
    durationMs,
    usage,
    stopReason,
    errorMessage,
    providerError: undefined,
  };

  return {
    text: primaryText,
    artifactStatePatch:
      Object.keys(artifactStatePatch).length > 0
        ? artifactStatePatch
        : undefined,
    sandboxId,
    sandboxDependencyProfileHash,
    piMessages: input.piMessages,
    diagnostics: resolvedDiagnostics,
  };
}
