import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { logInfo, logWarn, summarizeMessageText } from "@/chat/logging";
import {
  containsNoReplyMarker,
  isTrailingNoReplyUnit,
} from "@/chat/no-reply";
import type { PiMessage } from "@/chat/pi/messages";
import { createProviderError } from "@/chat/services/provider-error";
import type { TurnRoute } from "@/chat/services/turn-router";
import type { AgentTurnUsage } from "@/chat/usage";
import type { SandboxRef } from "@/chat/sandbox/ref";
import {
  extractAssistantText,
  getTerminalAssistantMessages,
  isAssistantMessage,
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import {
  decideReply,
  sanitizeAssistantText,
} from "@/chat/services/assistant-reply";

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
  sandboxRef?: SandboxRef;
  piMessages?: PiMessage[];
  diagnostics: AgentTurnDiagnostics;
}

export interface TurnResultInput {
  newMessages: unknown[];
  userInput: string;
  toolCalls: string[];
  sandboxRef?: SandboxRef;
  piMessages?: PiMessage[];
  durationMs?: number;
  generatedFileCount: number;
  shouldTrace: boolean;
  usage?: AgentTurnUsage;
  executionProfile: TurnRoute;
  assistantUserName?: string;
  modelId: string;
}

/** Process raw agent messages into a structured AgentRunResult. */
export function buildTurnResult(input: TurnResultInput): AgentRunResult {
  const {
    newMessages,
    toolCalls,
    sandboxRef,
    durationMs,
    shouldTrace,
    usage,
    executionProfile,
    modelId,
  } = input;

  const toolResults = newMessages.filter(isToolResultMessage);
  const assistantMessages = newMessages.filter(isAssistantMessage);
  const terminalAssistantMessages = getTerminalAssistantMessages(newMessages);

  const rawPrimaryText = sanitizeAssistantText(
    terminalAssistantMessages
      .map((message) => extractAssistantText(message))
      .join("\n\n"),
  ).trim();
  // Suppress only the marker message (or last-line marker unit). Earlier
  // assistant messages in the block still deliver. Tool-call tails are not
  // no-reply. Mid-sentence marker mentions still deliver.
  const primaryText = terminalAssistantMessages
    .map((message) => decideReply(message))
    .filter(
      (output): output is { kind: "deliver"; text: string } =>
        output.kind === "deliver",
    )
    .map((output) => output.text)
    .join("\n\n");
  const terminalTexts = terminalAssistantMessages.map((message) =>
    sanitizeAssistantText(extractAssistantText(message)),
  );
  const lastTerminalText = [...terminalTexts]
    .reverse()
    .find((text) => text.length > 0);
  const noReplyRequested =
    !primaryText &&
    lastTerminalText !== undefined &&
    isTrailingNoReplyUnit(lastTerminalText);

  const toolErrorCount = toolResults.filter((result) => result.isError).length;
  const reactionPerformed = toolResults.some(
    (result) =>
      !isToolResultError(result) &&
      normalizeToolNameFromResult(result) === "addReaction",
  );
  const completedWithoutTerminalText = noReplyRequested;
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

  if (noReplyRequested) {
    const markerCategory = reactionPerformed ? "reaction" : "none";
    const markerAttributes = {
      "app.ai.no_reply_marker": true,
      "app.ai.no_reply_marker_category": markerCategory,
      "app.ai.no_reply_marker_accepted": !isProviderError,
    };

    if (!isProviderError) {
      logInfo("ai.no_reply_marker.accepted", markerAttributes);
    }
  } else if (containsNoReplyMarker(rawPrimaryText)) {
    logWarn("ai.no_reply_marker.mixed_text", {
      "app.ai.no_reply_marker": true,
      "app.ai.no_reply_marker_mode": "mixed",
    });
  }

  if (!primaryText && !completedWithoutTerminalText && !isProviderError) {
    logWarn("ai.model_response.empty", {
      "app.ai.tool_results": toolResults.length,
      "app.ai.tool_error_results": toolErrorCount,
      "app.ai.generated_files": input.generatedFileCount,
    });
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
  const suppressedPrimaryText = Boolean(
    rawPrimaryText && !noReplyRequested && !primaryText,
  );
  const resolvedOutcome: AgentTurnDiagnostics["outcome"] = suppressedPrimaryText
    ? "execution_failure"
    : outcome;

  if (shouldTrace) {
    logInfo("agent.message.generated", {
      "app.message.kind": "assistant_outbound",
      "app.message.length": primaryText.length,
      "app.message.output": summarizeMessageText(primaryText),
      "app.ai.outcome": resolvedOutcome,
      "app.ai.assistant_messages": assistantMessages.length,
      ...(stopReason ? { "gen_ai.response.finish_reasons": [stopReason] } : undefined),
    });
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
    providerError:
      resolvedOutcome === "provider_error" && errorMessage
        ? createProviderError(errorMessage, {
            modelId,
            retryable:
              lastAssistant !== undefined &&
              isAssistantMessage(lastAssistant) &&
              isRetryableAssistantError(lastAssistant),
          })
        : undefined,
  };

  return {
    text: primaryText,
    sandboxRef,
    piMessages: input.piMessages,
    diagnostics: resolvedDiagnostics,
  };
}
