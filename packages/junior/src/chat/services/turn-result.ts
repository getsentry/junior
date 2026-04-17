import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logInfo, logWarn } from "@/chat/logging";
import type { LogContext } from "@/chat/logging";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  buildReplyDeliveryPlan,
  type ReplyDeliveryPlan,
} from "@/chat/services/reply-delivery-plan";
import { isExplicitChannelPostIntent } from "@/chat/services/channel-intent";
import { enforceAttachmentClaimTruth } from "@/chat/services/attachment-claims";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  buildExecutionFailureMessage,
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

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  durationMs?: number;
  errorMessage?: string;
  providerError?: unknown;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
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
  correlation?: {
    threadId?: string;
    requesterId?: string;
    channelId?: string;
    runId?: string;
  };
  assistantUserName?: string;
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

  if (!primaryText && !sideEffectOnlySuccess) {
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
  const usedPrimaryText = Boolean(primaryText);
  const outcome: AgentTurnDiagnostics["outcome"] = primaryText
    ? stopReason === "error"
      ? "provider_error"
      : "success"
    : sideEffectOnlySuccess
      ? "success"
      : "execution_failure";
  const fallbackText = buildExecutionFailureMessage(toolErrorCount);
  const responseText =
    primaryText || (sideEffectOnlySuccess ? "" : fallbackText);
  const escapedOrRawPayload =
    Boolean(primaryText) &&
    (isExecutionEscapeResponse(primaryText) ||
      isRawToolPayloadResponse(primaryText));
  const resolvedText = escapedOrRawPayload
    ? fallbackText
    : enforceAttachmentClaimTruth(responseText, replyFiles.length > 0);
  const deliveryPlan =
    reactionPerformed &&
    !resolvedText &&
    replyFiles.length === 0 &&
    !channelPostPerformed
      ? {
          ...baseDeliveryPlan,
          postThreadText: false,
        }
      : baseDeliveryPlan;
  const deliveryMode: "thread" | "channel_only" = deliveryPlan.mode;
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
    ? "execution_failure"
    : outcome;

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
