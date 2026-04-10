import type { FileUpload } from "chat";
import { botConfig } from "@/chat/config";
import { logInfo, logWarn } from "@/chat/logging";
import type { LogContext } from "@/chat/logging";
import {
  buildReplyDeliveryPlan,
  type ReplyDeliveryPlan,
} from "@/chat/services/reply-delivery-plan";
import { isExplicitChannelPostIntent } from "@/chat/services/channel-intent";
import { enforceAttachmentClaimTruth } from "@/chat/services/attachment-claims";
import { extractOAuthStartedMessageFromToolResults } from "@/chat/oauth-flow";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import {
  buildExecutionFailureMessage,
  extractAssistantText,
  isAssistantMessage,
  isExecutionEscapeResponse,
  isRawToolPayloadResponse,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
  summarizeMessageText,
} from "@/chat/respond-helpers";
import type { RenderedCard } from "@/chat/tools/types";

function normalizeCardDuplicateLine(value: string): string {
  return value
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[\s*•\-#>🔗]+/, "")
    .replace(/\s+[—–-]\s+/g, ": ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isRedundantCardIntroLine(value: string): boolean {
  const normalized = value
    .replace(/^[\s*•\-#>]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!normalized) {
    return false;
  }

  return /^(?:here(?:'s| is)|showing|sharing|found|returning|most recent|latest|top|current|this is)\b.*(?:issue|card|result|match|item|alert|incident|event|problem)?[:.]?$/.test(
    normalized,
  );
}

function stripRenderedCardDuplication(
  primaryText: string,
  renderedCards: RenderedCard[],
): string {
  if (!primaryText || renderedCards.length !== 1) {
    return primaryText;
  }

  const card = renderedCards[0];
  const duplicateLines = new Set(
    (card.dedupeTextLines ?? [])
      .map(normalizeCardDuplicateLine)
      .filter((line) => line.length > 0),
  );
  if (duplicateLines.size === 0) {
    return primaryText;
  }

  let removedAny = false;
  const keptLines: string[] = [];

  for (const line of primaryText.split("\n")) {
    const normalized = normalizeCardDuplicateLine(line);
    const isDuplicateLine =
      normalized.length > 0 && duplicateLines.has(normalized);
    const isCardLinkLine =
      normalized.length > 0 && /^(view|open) (in|on) /.test(normalized);

    if (isDuplicateLine || isCardLinkLine) {
      removedAny = true;
      continue;
    }

    keptLines.push(line);
  }

  if (!removedAny) {
    return primaryText;
  }

  return keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripRenderedCardIntroText(
  primaryText: string,
  renderedCards: RenderedCard[],
): string {
  if (!primaryText || renderedCards.length === 0) {
    return primaryText;
  }

  const lines = primaryText.split("\n");
  let start = 0;
  while (start < lines.length && isRedundantCardIntroLine(lines[start] ?? "")) {
    start += 1;
  }

  if (start === 0) {
    return primaryText;
  }

  return lines
    .slice(start)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  errorMessage?: string;
  providerError?: unknown;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  stopReason?: string;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usedPrimaryText: boolean;
}

export interface AssistantReply {
  text: string;
  files?: FileUpload[];
  artifactStatePatch?: Partial<ThreadArtifactsState>;
  deliveryPlan?: ReplyDeliveryPlan;
  deliveryMode?: "thread" | "channel_only";
  renderedCards?: RenderedCard[];
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  diagnostics: AgentTurnDiagnostics;
}

export interface TurnResultInput {
  newMessages: unknown[];
  userInput: string;
  replyFiles: FileUpload[];
  artifactStatePatch: Partial<ThreadArtifactsState>;
  renderedCards: RenderedCard[];
  toolCalls: string[];
  sandboxId?: string;
  sandboxDependencyProfileHash?: string;
  generatedFileCount: number;
  hasTextDeltaCallback: boolean;
  shouldTrace: boolean;
  spanContext: LogContext;
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
    renderedCards,
    toolCalls,
    sandboxId,
    sandboxDependencyProfileHash,
    hasTextDeltaCallback,
    shouldTrace,
    spanContext,
    correlation,
    assistantUserName,
  } = input;

  const toolResults = newMessages.filter(isToolResultMessage);
  const assistantMessages = newMessages.filter(isAssistantMessage);
  const hasRenderedCards = renderedCards.length > 0;

  const primaryText = assistantMessages
    .map((message) => extractAssistantText(message))
    .join("\n\n")
    .trim();
  const trimmedCardText = stripRenderedCardIntroText(
    stripRenderedCardDuplication(primaryText, renderedCards),
    renderedCards,
  );
  const oauthStartedMessage =
    extractOAuthStartedMessageFromToolResults(toolResults);

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
  const baseDeliveryPlan = buildReplyDeliveryPlan({
    explicitChannelPostIntent,
    channelPostPerformed,
    hasFiles: replyFiles.length > 0,
    streamingThreadReply: hasTextDeltaCallback,
  });
  const deliveryMode: "thread" | "channel_only" = baseDeliveryPlan.mode;

  if (!primaryText && !oauthStartedMessage && !hasRenderedCards) {
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

  const lastAssistant = assistantMessages.at(-1) as
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
  const usedPrimaryText = Boolean(trimmedCardText);
  const hasVisibleResponse = Boolean(
    trimmedCardText || oauthStartedMessage || hasRenderedCards,
  );
  const outcome: AgentTurnDiagnostics["outcome"] = hasVisibleResponse
    ? stopReason === "error"
      ? "provider_error"
      : "success"
    : "execution_failure";
  const fallbackText = oauthStartedMessage
    ? oauthStartedMessage
    : hasRenderedCards
      ? ""
      : buildExecutionFailureMessage(toolErrorCount);
  const responseText = trimmedCardText || fallbackText;
  const escapedOrRawPayload =
    Boolean(trimmedCardText) &&
    (isExecutionEscapeResponse(trimmedCardText) ||
      isRawToolPayloadResponse(trimmedCardText));
  const resolvedText = escapedOrRawPayload
    ? fallbackText
    : enforceAttachmentClaimTruth(responseText, replyFiles.length > 0);
  const deliveryPlan =
    !resolvedText && hasRenderedCards
      ? { ...baseDeliveryPlan, postThreadText: false }
      : baseDeliveryPlan;
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = escapedOrRawPayload
    ? oauthStartedMessage
      ? outcome
      : "execution_failure"
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
    renderedCards: hasRenderedCards ? renderedCards : undefined,
    deliveryPlan,
    deliveryMode,
    sandboxId,
    sandboxDependencyProfileHash,
    diagnostics: resolvedDiagnostics,
  };
}
