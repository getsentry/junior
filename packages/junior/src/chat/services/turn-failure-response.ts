import type { LogContext } from "@/chat/logging";
import { buildTurnFailureResponse } from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import type { AssistantReply } from "@/chat/services/turn-result";

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

function getFailureCapture(reply: AssistantReply): {
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
  reply: AssistantReply,
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
          "app.ai.reasoning_effort": reply.diagnostics.thinkingLevel,
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
  reply: AssistantReply;
  logException: LogException;
  context: LogContext;
  attributes?: Record<string, unknown>;
}): AssistantReply {
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

  return {
    ...args.reply,
    text: buildTurnFailureResponse(eventId),
    deliveryMode: "thread",
    deliveryPlan: {
      mode: "thread",
      postThreadText: true,
      attachFiles:
        args.reply.files && args.reply.files.length > 0 ? "inline" : "none",
    },
  };
}
