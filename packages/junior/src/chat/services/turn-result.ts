import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { logInfo, logWarn, summarizeMessageText } from "@/chat/logging";
import { isNoReplyMarker } from "@/chat/no-reply";
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
import {
  readAutomationResult,
  type AutomationResult,
} from "@/chat/automation-result";

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
  /**
   * Sanitized terminal text for diagnostics and failure fallback. For an
   * Automation run that declared `send_message`, this is the declared message.
   */
  text: string;
  /** Declared result of a Scheduled automation or Event automation run. */
  automation?: AutomationResult;
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
  /** Automation runs succeed only with one declared result. */
  requireAutomationResult?: boolean;
}

const MISSING_AUTOMATION_RESULT_ERROR =
  "Automation run ended without a declared result.";

/** Process raw agent messages into a structured AgentRunResult. */
export function buildTurnResult(input: TurnResultInput): AgentRunResult {
  if (input.requireAutomationResult) {
    return buildAutomationTurnResult(input);
  }
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
  const primaryText = terminalAssistantMessages
    .map((message) => decideReply(message))
    .filter(
      (output): output is { kind: "deliver"; text: string } =>
        output.kind === "deliver",
    )
    .map((output) => output.text)
    .join("\n\n");
  // Intentional silence only for marker text. Tool-call suppress is not no-reply.
  const terminalTexts = terminalAssistantMessages.map((message) =>
    sanitizeAssistantText(extractAssistantText(message)),
  );
  const noReplyRequested =
    !primaryText &&
    terminalTexts.some((text) => isNoReplyMarker(text)) &&
    terminalTexts.every((text) => !text || isNoReplyMarker(text));

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
  }

  if (!primaryText && !completedWithoutTerminalText && !isProviderError) {
    logWarn("ai.model_response.empty", {
      "app.ai.tool_results": toolResults.length,
      "app.ai.tool_error_results": toolErrorCount,
      "app.ai.generated_files": input.generatedFileCount,
    });
  }

  const usedPrimaryText = Boolean(rawPrimaryText);
  const suppressedPrimaryText = Boolean(
    rawPrimaryText && !noReplyRequested && !primaryText,
  );
  let outcome: AgentTurnDiagnostics["outcome"];
  if (isProviderError) {
    outcome = "provider_error";
  } else if (suppressedPrimaryText) {
    outcome = "execution_failure";
  } else if (primaryText || completedWithoutTerminalText) {
    outcome = "success";
  } else {
    outcome = "execution_failure";
  }

  if (shouldTrace) {
    logInfo("agent.message.generated", {
      "app.message.kind": "assistant_outbound",
      "app.message.length": primaryText.length,
      "app.message.output": summarizeMessageText(primaryText),
      "app.ai.outcome": outcome,
      "app.ai.assistant_messages": assistantMessages.length,
      ...(stopReason
        ? { "gen_ai.response.finish_reasons": [stopReason] }
        : undefined),
    });
  }

  const resolvedDiagnostics: AgentTurnDiagnostics = {
    outcome,
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
      outcome === "provider_error" && errorMessage
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

/**
 * Build the result of an Automation run from its declared result.
 *
 * Final assistant text is diagnostic only. A run without a declared result is
 * an execution failure.
 */
function buildAutomationTurnResult(input: TurnResultInput): AgentRunResult {
  const { newMessages, toolCalls, executionProfile, modelId } = input;
  const toolResults = newMessages.filter(isToolResultMessage);
  const assistantMessages = newMessages.filter(isAssistantMessage);
  const lastAssistant = assistantMessages.at(-1);
  const stopReason = lastAssistant?.stopReason;
  const providerErrorMessage =
    stopReason === "error" ? lastAssistant?.errorMessage : undefined;
  const automation = readAutomationResult(newMessages);
  const outcome: AgentTurnDiagnostics["outcome"] =
    stopReason === "error"
      ? "provider_error"
      : automation
        ? "success"
        : "execution_failure";
  const errorMessage =
    outcome === "provider_error"
      ? providerErrorMessage
      : outcome === "execution_failure"
        ? MISSING_AUTOMATION_RESULT_ERROR
        : undefined;

  if (input.shouldTrace) {
    logInfo("agent.message.generated", {
      "app.message.kind": "automation_result",
      "app.ai.outcome": outcome,
      "app.automation.result": automation?.result ?? "missing",
      "app.ai.assistant_messages": assistantMessages.length,
    });
  }

  return {
    text: automation?.result === "send_message" ? automation.message : "",
    ...(automation ? { automation } : undefined),
    sandboxRef: input.sandboxRef,
    piMessages: input.piMessages,
    diagnostics: {
      outcome,
      modelId,
      assistantMessageCount: assistantMessages.length,
      reasoningLevel: executionProfile.reasoningLevel,
      toolCalls,
      toolResultCount: toolResults.length,
      toolErrorCount: toolResults.filter((result) => result.isError).length,
      usedPrimaryText: automation?.result === "send_message",
      durationMs: input.durationMs,
      usage: input.usage,
      ...(stopReason ? { stopReason } : undefined),
      ...(errorMessage ? { errorMessage } : undefined),
      providerError:
        outcome === "provider_error" && providerErrorMessage
          ? createProviderError(providerErrorMessage, {
              modelId,
              retryable:
                lastAssistant !== undefined &&
                isRetryableAssistantError(lastAssistant),
            })
          : undefined,
    },
  };
}
