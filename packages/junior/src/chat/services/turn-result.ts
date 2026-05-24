import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logInfo, logWarn } from "@/chat/logging";
import type { LogContext } from "@/chat/logging";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  buildReplyDeliveryPlan,
  isReactionOnlyIntent,
  type ReplyDeliveryPlan,
} from "@/chat/services/reply-delivery-plan";
import { isExplicitChannelPostIntent } from "@/chat/services/channel-intent";
import { enforceAttachmentClaimTruth } from "@/chat/services/attachment-claims";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  extractAssistantText,
  getTerminalAssistantMessages,
  isAssistantMessage,
  isExecutionEscapeResponse,
  isRawToolPayloadResponse,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  summarizeMessageText,
} from "@/chat/respond-helpers";

const POST_CANVAS_REPLY_MAX_CHARS = 700;
const POST_CANVAS_REPLY_MAX_LINES = 8;

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

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  deliveryPlan?: ReplyDeliveryPlan;
  deliveryMode?: "thread" | "channel_only";
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  diagnostics: AgentTurnDiagnostics;
}

export interface TurnResultInput {
  newMessages: unknown[];
  userInput: string;
  replyFiles: FileUpload[];
  artifactStatePatch: Partial<ThreadArtifactsState>;
  toolCalls: string[];
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  durationMs?: number;
  generatedFileCount: number;
  shouldTrace: boolean;
  spanContext: LogContext;
  usage?: AgentTurnUsage;
  thinkingSelection: TurnThinkingSelection;
  correlation?: {
    threadId?: string;
    requesterId?: string;
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

/** Process raw agent messages into a structured AssistantReply. */
export function buildTurnResult(input: TurnResultInput): AssistantReply {
  const {
    newMessages,
    userInput,
    replyFiles,
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

  const primaryText = terminalAssistantMessages
    .map((message) => extractAssistantText(message))
    .join("\n\n")
    .trim();

  const toolErrorCount = toolResults.filter((result) => result.isError).length;
  const explicitChannelPostIntent = isExplicitChannelPostIntent(userInput);
  const successfulToolNames = new Set(
    toolResults
      .filter((result) => !isToolResultError(result))
      .map((result) => normalizeToolNameFromResult(result))
      .filter((value): value is string => Boolean(value)),
  );
  const channelPostPerformed = successfulToolNames.has(
    "slackChannelPostMessage",
  );
  const canvasCreated = successfulToolNames.has("slackCanvasCreate");
  const reactionPerformed = successfulToolNames.has("slackMessageAddReaction");
  const baseDeliveryPlan = buildReplyDeliveryPlan({
    explicitChannelPostIntent,
    channelPostPerformed,
    hasFiles: replyFiles.length > 0,
  });
  const sideEffectOnlySuccess =
    !primaryText &&
    toolErrorCount === 0 &&
    (reactionPerformed || channelPostPerformed || replyFiles.length > 0);
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

  if (!primaryText && !sideEffectOnlySuccess && !isProviderError) {
    logWarn(
      "ai_model_response_empty",
      {
        slackThreadId: correlation?.threadId,
        slackUserId: correlation?.requesterId,
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

  const usedPrimaryText = Boolean(primaryText);
  let outcome: AgentTurnDiagnostics["outcome"];
  if (isProviderError) {
    outcome = "provider_error";
  } else if (primaryText || sideEffectOnlySuccess) {
    outcome = "success";
  } else {
    outcome = "execution_failure";
  }
  const suppressReactionOnlyText =
    reactionPerformed &&
    !channelPostPerformed &&
    replyFiles.length === 0 &&
    Boolean(primaryText) &&
    isReactionOnlyIntent(userInput);
  const rawResponseText = suppressReactionOnlyText ? "" : primaryText;
  const responseText =
    canvasCreated && isVerbosePostCanvasReply(rawResponseText)
      ? buildBriefPostCanvasReply(artifactStatePatch)
      : rawResponseText;
  const escapedOrRawPayload =
    Boolean(primaryText) &&
    (isExecutionEscapeResponse(primaryText) ||
      isRawToolPayloadResponse(primaryText));
  const resolvedText = escapedOrRawPayload
    ? ""
    : enforceAttachmentClaimTruth(responseText, replyFiles.length > 0);
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
    ? "execution_failure"
    : outcome;
  const deliveryPlan =
    resolvedOutcome === "success" &&
    !resolvedText &&
    replyFiles.length === 0 &&
    (reactionPerformed || channelPostPerformed)
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
    files: replyFiles.length > 0 ? replyFiles : undefined,
    artifactStatePatch:
      Object.keys(artifactStatePatch).length > 0
        ? artifactStatePatch
        : undefined,
    deliveryPlan,
    deliveryMode,
    sandboxId,
    sandboxDependencyProfileHash,
    diagnostics: resolvedDiagnostics,
  };
}
