import { buildTurnFailureResponse, logWarn } from "@/chat/logging";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import {
  findProviderError,
  getProviderErrorAttributes,
  getProviderErrorUserMessage,
  ProviderError,
} from "@/chat/services/provider-error";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { TOOL_ACTION_REVIEW_LIMIT_MESSAGE } from "@/chat/tool-support/action-review";

type LogException = (
  error: unknown,
  eventName: string,
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
    errorMessage?: string;
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

function getFailureCapture(reply: AgentRunResult): {
  attributes: Record<string, unknown>;
  body: string;
  error: unknown;
  eventName: string;
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
      : {}),
    ...(reply.diagnostics.stopReason
      ? {
          "gen_ai.response.finish_reasons": [reply.diagnostics.stopReason],
        }
      : {}),
    ...(reply.diagnostics.errorMessage &&
    reply.diagnostics.outcome !== "provider_error"
      ? { "exception.message": reply.diagnostics.errorMessage }
      : {}),
  };
}

/** Sanitized failure fallback plus its optional captured event ID. */
export interface FinalizedTurnFailure {
  eventId?: string;
  reply: AgentRunResult;
}

/** Enforce one captured failure response and return its structured correlation. */
export function finalizeFailedTurnReplyWithEvent(args: {
  reply: AgentRunResult;
  logException: LogException;
  attributes?: Record<string, unknown>;
}): FinalizedTurnFailure {
  if (args.reply.diagnostics.outcome === "success") {
    return { reply: args.reply };
  }

  // Review-limit stops are expected control flow after repeated denials.
  // Keep the turn failed for delivery/metrics, but do not open a Sentry issue.
  if (args.reply.diagnostics.errorMessage === TOOL_ACTION_REVIEW_LIMIT_MESSAGE) {
    logWarn("guardian.action_review.exhausted", {
      ...getAgentTurnDiagnosticsAttributes(args.reply),
      ...args.attributes,
    });
    return {
      reply: {
        ...args.reply,
        text: "I stopped because action review rejected three consecutive tool attempts.",
      },
    };
  }

  const capture = getFailureCapture(args.reply);
  const eventId = requireTurnFailureEventId(
    args.logException(capture.error, capture.eventName, {
      ...getAgentTurnDiagnosticsAttributes(args.reply),
      ...args.attributes,
      ...capture.attributes,
    }),
    capture.eventName,
  );

  // Only text derived from actual assistant messages may be delivered as
  // partial output. Synthesized failure replies (runtime catch-alls) report
  // zero assistant messages, so raw exception text never reaches the user;
  // the sanitized fallback with its event id owns the visible failure.
  const providerPartialText =
    args.reply.diagnostics.outcome === "provider_error" &&
    args.reply.diagnostics.assistantMessageCount > 0
      ? args.reply.text.trim()
      : "";
  const providerUserMessage =
    args.reply.diagnostics.providerError instanceof ProviderError
      ? getProviderErrorUserMessage(args.reply.diagnostics.providerError)
      : "";
  const failureText = providerUserMessage
    ? `${providerUserMessage} Reference: \`event_id=${eventId}\`.`
    : buildTurnFailureResponse(eventId);

  return {
    eventId,
    reply: {
      ...args.reply,
      text: providerPartialText
        ? `${providerPartialText}${getInterruptionMarker()}`
        : failureText,
    },
  };
}

/** Enforce one captured, event-ID-bearing failure response before delivery. */
export function finalizeFailedTurnReply(
  args: Parameters<typeof finalizeFailedTurnReplyWithEvent>[0],
): AgentRunResult {
  return finalizeFailedTurnReplyWithEvent(args).reply;
}
