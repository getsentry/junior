import { botConfig } from "@/chat/config";
import { logInfo, logWarn, summarizeMessageText } from "@/chat/logging";
import type { LogContext } from "@/chat/logging";
import {
  containsNoReplyMarker,
  isNoReplyMarker,
  stripNoReplyMarker,
} from "@/chat/no-reply";
import type { PiMessage } from "@/chat/pi/messages";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";
import type { ReplyDeliveryPlan } from "@/chat/services/reply-delivery-plan";
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

  const compact = text.replace(/\s+/g, " ");
  return /"type"\s*:\s*"tool[-_](use|call|result|error)"/i.test(compact);
}

const POST_CANVAS_REPLY_MAX_CHARS = 700;
const POST_CANVAS_REPLY_MAX_LINES = 8;
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
  thinkingLevel?: TurnThinkingSelection["thinkingLevel"];
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usage?: AgentTurnUsage;
  usedPrimaryText: boolean;
}

export interface AgentRunResult {
  text: string;
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  deliveryPlan?: ReplyDeliveryPlan;
  deliveryMode?: "thread" | "channel_only";
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
  thinkingSelection: TurnThinkingSelection;
  correlation?: {
    threadId?: string;
    actorId?: string;
    channelId?: string;
    runId?: string;
  };
  assistantUserName?: string;
}

function isVerbosePostCanvasReply(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return (
    text.length > POST_CANVAS_REPLY_MAX_CHARS ||
    lines.length > POST_CANVAS_REPLY_MAX_LINES
  );
}

function getCreatedCanvasUrl(
  artifactStatePatch: Partial<ThreadArtifactsState>,
): string | undefined {
  if (artifactStatePatch.lastCanvasUrl) {
    return artifactStatePatch.lastCanvasUrl;
  }
  return artifactStatePatch.recentCanvases?.find((canvas) => canvas.url)?.url;
}

function buildBriefPostCanvasReply(
  artifactStatePatch: Partial<ThreadArtifactsState>,
): string {
  const canvasUrl = getCreatedCanvasUrl(artifactStatePatch);
  return canvasUrl
    ? `I created a canvas with the full reference: ${canvasUrl}`
    : "I created a canvas with the full reference.";
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
    thinkingSelection,
    correlation,
    assistantUserName,
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
  const primaryText = exactNoReplyMarker
    ? ""
    : mixedNoReplyMarker
      ? stripNoReplyMarker(rawPrimaryText)
      : rawPrimaryText;

  const toolErrorCount = toolResults.filter((result) => result.isError).length;
  const successfulToolResults = toolResults.filter(
    (result) => !isToolResultError(result),
  );
  const successfulToolNames = new Set(
    successfulToolResults
      .map((result) => normalizeToolNameFromResult(result))
      .filter((value): value is string => Boolean(value)),
  );
  const canvasCreated = successfulToolNames.has("slackCanvasCreate");
  const reactionPerformed = successfulToolNames.has("addReaction");
  const silentCompletionSuccess = exactNoReplyMarker;
  const baseDeliveryPlan: ReplyDeliveryPlan = {
    mode: "thread",
    postThreadText: true,
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
    const markerContext = {
      slackThreadId: correlation?.threadId,
      slackUserId: correlation?.actorId,
      slackChannelId: correlation?.channelId,
      runId: correlation?.runId,
      assistantUserName,
      modelId: botConfig.modelId,
    };
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
      {
        slackThreadId: correlation?.threadId,
        slackUserId: correlation?.actorId,
        slackChannelId: correlation?.channelId,
        runId: correlation?.runId,
        assistantUserName,
        modelId: botConfig.modelId,
      },
      {
        "app.ai.no_reply_marker": true,
        "app.ai.no_reply_marker_mode": "mixed",
      },
      "No-reply marker appeared with visible assistant text",
    );
  }

  if (!primaryText && !silentCompletionSuccess && !isProviderError) {
    logWarn(
      "ai_model_response_empty",
      {
        slackThreadId: correlation?.threadId,
        slackUserId: correlation?.actorId,
        slackChannelId: correlation?.channelId,
        runId: correlation?.runId,
        assistantUserName,
        modelId: botConfig.modelId,
      },
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
  } else if (primaryText || silentCompletionSuccess) {
    outcome = "success";
  } else {
    outcome = "execution_failure";
  }
  const rawResponseText = primaryText;
  const responseText =
    canvasCreated && isVerbosePostCanvasReply(rawResponseText)
      ? buildBriefPostCanvasReply(artifactStatePatch)
      : rawResponseText;
  const escapedOrRawPayload =
    Boolean(primaryText) &&
    (isExecutionEscapeResponse(primaryText) ||
      isRawToolPayloadResponse(primaryText));
  const resolvedText = escapedOrRawPayload ? "" : responseText;
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
    ? "execution_failure"
    : outcome;
  const deliveryPlan =
    resolvedOutcome === "success" && !resolvedText
      ? {
          ...baseDeliveryPlan,
          postThreadText: false,
        }
      : baseDeliveryPlan;
  const deliveryMode: "thread" | "channel_only" = deliveryPlan.mode;

  if (shouldTrace) {
    logInfo(
      "agent_message_out",
      spanContext,
      {
        "app.message.kind": "assistant_outbound",
        "app.message.length": resolvedText.length,
        "app.message.output": summarizeMessageText(resolvedText),
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
    modelId: botConfig.modelId,
    assistantMessageCount: assistantMessages.length,
    thinkingLevel: thinkingSelection.thinkingLevel,
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
    text: resolvedText,
    artifactStatePatch:
      Object.keys(artifactStatePatch).length > 0
        ? artifactStatePatch
        : undefined,
    deliveryPlan,
    deliveryMode,
    sandboxId,
    sandboxDependencyProfileHash,
    piMessages: input.piMessages,
    diagnostics: resolvedDiagnostics,
  };
}
