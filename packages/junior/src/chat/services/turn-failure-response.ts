import type { ConversationTurnFailureReason } from "@/chat/conversations/history";
import { buildTurnFailureResponse } from "@/chat/logging";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import { formatSentryEventReference } from "@/chat/sentry-links";
import { ToolActionReviewUnavailableError } from "@/chat/guardian/gate";
import { findInErrorChain } from "@/chat/sandbox/errors";
import {
  createProviderError,
  findProviderError,
  getProviderErrorAttributes,
  getProviderErrorUserMessage,
} from "@/chat/services/provider-error";
import type { AgentRunResult } from "@/chat/services/turn-result";

type TurnFailureEventName =
  | "agent.turn.provider_error"
  | "agent.turn.execution.failed";

type LogException = (
  error: unknown,
  eventName: TurnFailureEventName,
  attributes?: Record<string, unknown>,
) => string | undefined;

/** Require captured turn failures to carry a real Sentry event reference. */
export function requireTurnFailureEventId(
  eventId: string | undefined,
  eventName: string,
): string {
  if (!eventId) {
    throw new Error(`Sentry did not return an event ID for ${eventName}`);
  }
  return eventId;
}

function getExecutionFailureReason(reply: {
  diagnostics: {
    assistantMessageCount: number;
    errorMessage?: string | undefined;
    toolErrorCount: number;
  };
}): string {
  const errorMessage = reply.diagnostics.errorMessage?.trim();
  if (errorMessage) {
    return errorMessage;
  }
  if (reply.diagnostics.toolErrorCount > 0) {
    return `${reply.diagnostics.toolErrorCount} tool result error(s)`;
  }
  if (reply.diagnostics.assistantMessageCount > 0) {
    return "assistant returned no text";
  }
  return "empty assistant turn";
}

/** Return a fixed reason label for a failed model turn. */
export function getTurnFailureReason(
  reply: AgentRunResult,
): ConversationTurnFailureReason | undefined {
  if (reply.diagnostics.outcome === "success") {
    return undefined;
  }
  if (reply.diagnostics.outcome === "provider_error") {
    return (
      findProviderError(reply.diagnostics.providerError)?.kind ?? "unknown"
    );
  }
  if (reply.diagnostics.toolErrorCount > 0) {
    return "tool_errors";
  }
  if (
    reply.diagnostics.usedPrimaryText &&
    reply.diagnostics.assistantMessageCount > 0
  ) {
    return "suppressed_output";
  }
  return "empty_output";
}

function getFailureCapture(reply: AgentRunResult): {
  attributes: Record<string, unknown>;
  body: string;
  error: unknown;
  eventName: TurnFailureEventName;
} {
  if (reply.diagnostics.outcome === "provider_error") {
    const providerError = findProviderError(reply.diagnostics.providerError);
    return {
      eventName: "agent.turn.provider_error",
      error:
        reply.diagnostics.providerError ??
        new Error(
          reply.diagnostics.errorMessage ??
            "Provider error without explicit message",
        ),
      attributes: providerError
        ? getProviderErrorAttributes(providerError)
        : {},
      body: "Agent turn failed with provider error",
    };
  }

  const failureReason = getExecutionFailureReason(reply);
  return {
    eventName: "agent.turn.execution.failed",
    error: new Error(`Agent turn execution failure: ${failureReason}`),
    attributes: {
      "app.ai.execution_failure_reason": failureReason,
    },
    body: "Agent turn completed with execution failure",
  };
}

/** Keep failed-turn Sentry captures and completion spans on the same keys. */
export function getAgentTurnDiagnosticsAttributes(
  reply: AgentRunResult,
): Record<string, unknown> {
  return {
    "app.ai.outcome": reply.diagnostics.outcome,
    "app.ai.assistant_messages": reply.diagnostics.assistantMessageCount,
    "app.ai.tool_results": reply.diagnostics.toolResultCount,
    "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
    "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
    "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
    ...(reply.diagnostics.reasoningLevel
      ? {
          "gen_ai.request.reasoning.level": reply.diagnostics.reasoningLevel,
        }
      : undefined),
    ...(reply.diagnostics.stopReason
      ? {
          "gen_ai.response.finish_reasons": [reply.diagnostics.stopReason],
        }
      : undefined),
    ...(reply.diagnostics.errorMessage &&
    reply.diagnostics.outcome !== "provider_error"
      ? { "exception.message": reply.diagnostics.errorMessage }
      : undefined),
  };
}

/**
 * Build the failure reply that names the upstream provider when a model call
 * in the error's cause chain failed, or undefined for any other failure.
 * Action review runs its own model, so its failure says which step it served.
 */
export function buildProviderFailureResponse(
  error: unknown,
  eventId: string,
): string | undefined {
  const providerError = findProviderError(error);
  if (!providerError) {
    return undefined;
  }
  const actionReview = findInErrorChain(
    error,
    (candidate) => candidate instanceof ToolActionReviewUnavailableError,
  );
  const message = getProviderErrorUserMessage(
    providerError,
    actionReview ? { purpose: "action review" } : {},
  );
  return `${message} Reference: ${formatSentryEventReference(eventId)}.`;
}

/** Sanitized failure fallback plus its optional captured event ID. */
export interface FinalizedTurnFailure {
  eventId?: string;
  failureReason?: ConversationTurnFailureReason;
  reply: AgentRunResult;
}

/**
 * Report one failed agent run to Sentry and attach the event ID.
 *
 * The agent run is the only caller. It reports inside its log and privacy
 * context, so the event has the run's context and redaction. Callers read the
 * ID from `diagnostics.eventId` and never report the run again.
 */
export function captureTurnFailure(
  result: AgentRunResult,
  logException: LogException,
): AgentRunResult {
  const failureReason = getTurnFailureReason(result);
  const capture = getFailureCapture(result);
  const eventId = requireTurnFailureEventId(
    logException(capture.error, capture.eventName, {
      ...getAgentTurnDiagnosticsAttributes(result),
      ...capture.attributes,
      ...(failureReason
        ? { "app.ai.failure_reason": failureReason }
        : undefined),
    }),
    capture.eventName,
  );
  return { ...result, diagnostics: { ...result.diagnostics, eventId } };
}

/**
 * The provider failure behind a failed run. A model message that ends the
 * run with no text, no tool call, and no error is an empty provider
 * response, as model APIs return during some outages.
 */
function runProviderError(
  reply: AgentRunResult,
  failureReason: ConversationTurnFailureReason | undefined,
): unknown {
  if (
    failureReason === "empty_output" &&
    reply.diagnostics.assistantMessageCount > 0 &&
    !reply.diagnostics.errorMessage
  ) {
    return createProviderError("The model returned an empty response.", {
      kind: "invalid_response",
      modelId: reply.diagnostics.modelId,
    });
  }
  return reply.diagnostics.providerError;
}

/** Build the failure reply for a reported failed run, with its event ID. */
export function finalizeFailedTurnReplyWithEvent(args: {
  reply: AgentRunResult;
}): FinalizedTurnFailure {
  if (args.reply.diagnostics.outcome === "success") {
    return { reply: args.reply };
  }

  const failureReason = getTurnFailureReason(args.reply);
  const eventId = args.reply.diagnostics.eventId;
  if (!eventId) {
    throw new Error("Failed agent run has no Sentry event ID");
  }

  // Only text derived from actual assistant messages may be delivered as
  // partial output. Synthesized failure replies (runtime catch-alls) report
  // zero assistant messages, so raw exception text never reaches the user;
  // the sanitized fallback with its event id owns the visible failure.
  const providerPartialText =
    args.reply.diagnostics.outcome === "provider_error" &&
    args.reply.diagnostics.assistantMessageCount > 0
      ? args.reply.text.trim()
      : "";
  const providerFailureText = buildProviderFailureResponse(
    runProviderError(args.reply, failureReason),
    eventId,
  );
  // Partial text keeps the provider failure after it, so the person still
  // learns why the reply stopped.
  const text = providerPartialText
    ? [`${providerPartialText}${getInterruptionMarker()}`, providerFailureText]
        .filter(Boolean)
        .join("\n\n")
    : (providerFailureText ?? buildTurnFailureResponse(eventId));

  return {
    eventId,
    ...(failureReason ? { failureReason } : undefined),
    reply: { ...args.reply, text },
  };
}

/** Enforce one captured, event-ID-bearing failure response before delivery. */
export function finalizeFailedTurnReply(
  args: Parameters<typeof finalizeFailedTurnReplyWithEvent>[0],
): AgentRunResult {
  return finalizeFailedTurnReplyWithEvent(args).reply;
}
