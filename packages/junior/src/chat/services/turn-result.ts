import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { logInfo, logWarn, summarizeMessageText } from "@/chat/logging";
import {
  isLegacyNoReplyMarker,
  readNoReply,
  type NoReply,
} from "@/chat/no-reply";
import type { PiMessage } from "@/chat/pi/messages";
import { createAssistantProviderError } from "@/chat/services/provider-error";
import type { TurnReasoningLevel } from "@/chat/reasoning-level";
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
import type { Reply, TurnAnswer } from "@/chat/turn-answer";
import {
  readBlockedReport,
  type BlockedReport,
} from "@/chat/agent-invocations/blocked-report";

export interface AgentTurnDiagnostics {
  assistantMessageCount: number;
  durationMs?: number | undefined;
  errorMessage?: string | undefined;
  providerError?: unknown | undefined;
  modelId: string;
  outcome: "success" | "execution_failure" | "provider_error";
  reasoningLevel?: TurnReasoningLevel;
  stopReason?: string | undefined;
  toolCalls: string[];
  toolErrorCount: number;
  toolResultCount: number;
  usage?: AgentTurnUsage | undefined;
  usedPrimaryText: boolean;
}

export interface AgentRunResult {
  /**
   * Sanitized terminal text for diagnostics and failure fallback, not success
   * delivery. A gated Turn that called `reply` carries that text.
   */
  text: string;
  /** Text of the `reply` call of a gated Turn. The runtime posts it. */
  reply?: Reply;
  /** Blocked report of a child agent run. */
  blocked?: BlockedReport;
  /** Set when the run ended with no reply. */
  noReply?: NoReply;
  sandboxRef?: SandboxRef | undefined;
  piMessages?: PiMessage[] | undefined;
  diagnostics: AgentTurnDiagnostics;
}

export interface TurnResultInput {
  newMessages: unknown[];
  userInput: string;
  toolCalls: string[];
  sandboxRef?: SandboxRef | undefined;
  piMessages?: PiMessage[];
  durationMs?: number;
  generatedFileCount: number;
  shouldTrace: boolean;
  usage?: AgentTurnUsage | undefined;
  reasoningLevel: TurnReasoningLevel;
  assistantUserName?: string;
  modelId: string;
  /**
   * Answer of a gated Turn, or `missing` when it ended without one. Absent
   * for a Turn that is not gated.
   */
  answer?: TurnAnswer | "missing";
  /**
   * The error that fails a gated Turn without an answer. Without it, the Turn
   * stays quiet.
   */
  missingAnswerError?: string;
}

/** Process raw agent messages into a structured AgentRunResult. */
export function buildTurnResult(input: TurnResultInput): AgentRunResult {
  if (input.answer) {
    return buildGatedTurnResult(input, input.answer);
  }
  const { newMessages, sandboxRef, shouldTrace } = input;

  const toolResults = newMessages.filter(isToolResultMessage);
  const assistantMessages = newMessages.filter(isAssistantMessage);
  const terminalAssistantMessages = getTerminalAssistantMessages(newMessages);
  // A blocked report ends the run with no text, and it is the run's result.
  const blocked = readBlockedReport(newMessages);

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
  // A tool-call tail is not a no-reply. Only the tool, or a final response that
  // is only a legacy marker, is.
  const terminalTexts = terminalAssistantMessages.map((message) =>
    sanitizeAssistantText(extractAssistantText(message)),
  );
  const legacyMarkerOnly =
    terminalTexts.some((text) => isLegacyNoReplyMarker(text)) &&
    terminalTexts.every((text) => !text || isLegacyNoReplyMarker(text));
  const noReply = primaryText
    ? undefined
    : (readNoReply(newMessages) ?? (legacyMarkerOnly ? {} : undefined));
  const noReplyRequested = Boolean(noReply);

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

  if (noReplyRequested && !isProviderError) {
    logInfo("ai.no_reply.accepted", {
      "app.ai.no_reply.category": reactionPerformed ? "reaction" : "none",
      "app.ai.no_reply.legacy_marker": legacyMarkerOnly,
    });
  }

  if (
    !primaryText &&
    !completedWithoutTerminalText &&
    !blocked &&
    !isProviderError
  ) {
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
  } else if (primaryText || completedWithoutTerminalText || blocked) {
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

  return {
    text: primaryText,
    ...(blocked ? { blocked } : undefined),
    ...(noReply ? { noReply } : undefined),
    sandboxRef,
    piMessages: input.piMessages,
    diagnostics: buildDiagnostics(input, {
      outcome,
      usedPrimaryText,
      stopReason,
      errorMessage,
      lastAssistant,
    }),
  };
}

function buildDiagnostics(
  input: TurnResultInput,
  result: {
    outcome: AgentTurnDiagnostics["outcome"];
    usedPrimaryText: boolean;
    stopReason?: string | undefined;
    errorMessage?: string | undefined;
    lastAssistant?: unknown | undefined;
  },
): AgentTurnDiagnostics {
  const { outcome, errorMessage, lastAssistant } = result;
  const assistant = isAssistantMessage(lastAssistant)
    ? lastAssistant
    : undefined;
  const toolResults = input.newMessages.filter(isToolResultMessage);
  return {
    outcome,
    modelId: input.modelId,
    assistantMessageCount: input.newMessages.filter(isAssistantMessage).length,
    reasoningLevel: input.reasoningLevel,
    toolCalls: input.toolCalls,
    toolResultCount: toolResults.length,
    toolErrorCount: toolResults.filter((toolResult) => toolResult.isError)
      .length,
    usedPrimaryText: result.usedPrimaryText,
    durationMs: input.durationMs,
    usage: input.usage,
    stopReason: result.stopReason,
    errorMessage,
    providerError:
      outcome === "provider_error" && errorMessage
        ? createAssistantProviderError(
            { errorMessage, rawStopReason: assistant?.rawStopReason },
            {
              modelId: input.modelId,
              retryable: assistant
                ? isRetryableAssistantError(assistant)
                : false,
            },
          )
        : undefined,
  };
}

/** Name of a Turn answer in telemetry. */
function answerName(answer: TurnAnswer | "missing"): string {
  if (answer === "missing") return "missing";
  if ("reply" in answer) return "reply";
  if ("noReply" in answer) return "noReply";
  return "reportBlocked";
}

/**
 * Build the result of a gated Turn from its answer. Final assistant text is
 * not used. A Turn without an answer posts nothing.
 */
function buildGatedTurnResult(
  input: TurnResultInput,
  answer: TurnAnswer | "missing",
): AgentRunResult {
  const lastAssistant = input.newMessages.filter(isAssistantMessage).at(-1);
  const stopReason = lastAssistant?.stopReason;
  const answered = answer !== "missing";
  // An answer decides the outcome, even when a later slice errs.
  const outcome: AgentTurnDiagnostics["outcome"] = answered
    ? "success"
    : stopReason === "error"
      ? "provider_error"
      : input.missingAnswerError
        ? "execution_failure"
        : "success";
  const errorMessage =
    outcome === "provider_error"
      ? lastAssistant?.errorMessage
      : outcome === "execution_failure"
        ? input.missingAnswerError
        : undefined;
  const reply = answered && "reply" in answer ? answer.reply : undefined;

  if (!answered && stopReason !== "error") {
    logWarn("agent.turn.answer.missing", {});
  }
  if (input.shouldTrace) {
    logInfo("agent.message.generated", {
      "app.message.kind": "turn_answer",
      "app.ai.outcome": outcome,
      "app.turn.answer": answerName(answer),
    });
  }

  return {
    text: reply?.text ?? "",
    ...(reply ? { reply } : undefined),
    ...(answered && "noReply" in answer
      ? { noReply: answer.noReply }
      : undefined),
    ...(answered && "blocked" in answer
      ? { blocked: answer.blocked }
      : undefined),
    sandboxRef: input.sandboxRef,
    piMessages: input.piMessages,
    diagnostics: buildDiagnostics(input, {
      outcome,
      usedPrimaryText: Boolean(reply),
      stopReason,
      errorMessage,
      lastAssistant,
    }),
  };
}
