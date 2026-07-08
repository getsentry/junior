import type { LogContext } from "@/chat/logging";
import { buildTurnFailureResponse } from "@/chat/logging";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import type { AgentRunResult } from "@/chat/services/turn-result";

type LogException = (
  error: unknown,
  eventName: string,
  context?: LogContext,
  attributes?: Record<string, unknown>,
  body?: string,
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
    return {
      eventName: "agent_turn_provider_error",
      error:
        reply.diagnostics.providerError ??
        new Error(
          reply.diagnostics.errorMessage ??
            "Provider error without explicit message",
        ),
      attributes: {},
      body: "Agent turn failed with provider error",
    };
  }

  const failureReason = getExecutionFailureReason(reply);
  return {
    eventName: "agent_turn_execution_failure",
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
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": "invoke_agent",
    "app.ai.outcome": reply.diagnostics.outcome,
    "app.ai.assistant_messages": reply.diagnostics.assistantMessageCount,
    "app.ai.tool_results": reply.diagnostics.toolResultCount,
    "app.ai.tool_error_results": reply.diagnostics.toolErrorCount,
    "app.ai.tool_call_count": reply.diagnostics.toolCalls.length,
    "app.ai.used_primary_text": reply.diagnostics.usedPrimaryText,
    ...(reply.diagnostics.thinkingLevel
      ? {
          "gen_ai.request.reasoning.level": reply.diagnostics.thinkingLevel,
        }
      : {}),
    ...(reply.diagnostics.stopReason
      ? {
          "gen_ai.response.finish_reasons": [reply.diagnostics.stopReason],
        }
      : {}),
    ...(reply.diagnostics.errorMessage
      ? { "exception.message": reply.diagnostics.errorMessage }
      : {}),
  };
}

/** Enforce one captured, event-ID-bearing failure response before delivery. */
export function finalizeFailedTurnReply(args: {
  reply: AgentRunResult;
  logException: LogException;
  context: LogContext;
  attributes?: Record<string, unknown>;
}): AgentRunResult {
  if (args.reply.diagnostics.outcome === "success") {
    return args.reply;
  }

  const capture = getFailureCapture(args.reply);
  const eventId = requireTurnFailureEventId(
    args.logException(
      capture.error,
      capture.eventName,
      args.context,
      {
        ...getAgentTurnDiagnosticsAttributes(args.reply),
        ...args.attributes,
        ...capture.attributes,
      },
      capture.body,
    ),
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

  return {
    ...args.reply,
    text: providerPartialText
      ? `${providerPartialText}${getInterruptionMarker()}`
      : buildTurnFailureResponse(eventId),
    deliveryMode: "thread",
    deliveryPlan: {
      mode: "thread",
      postThreadText: true,
    },
  };
}
