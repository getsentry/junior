import {
  logException,
  logWarn,
  setSpanAttributes,
  type LogContext,
} from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { McpToolError } from "@/chat/mcp/tool-manager";
import { SlackActionError } from "@/chat/slack/client";

function getToolErrorAttributes(
  error: unknown,
): Record<string, string | number> {
  if (!(error instanceof SlackActionError)) {
    return {};
  }

  return {
    "app.slack.error_code": error.code,
    ...(error.apiError ? { "app.slack.api_error": error.apiError } : {}),
    ...(error.detail ? { "app.slack.detail": error.detail } : {}),
    ...(error.detailLine !== undefined
      ? { "app.slack.detail_line": error.detailLine }
      : {}),
    ...(error.detailRule ? { "app.slack.detail_rule": error.detailRule } : {}),
  };
}

/** Handle tool execution errors: set span attributes, log, and rethrow. */
export function handleToolExecutionError(
  error: unknown,
  toolName: string,
  toolCallId: string | undefined,
  shouldTrace: boolean,
  traceContext: LogContext,
): never {
  setSpanAttributes({
    "error.type": error instanceof Error ? error.name : "tool_execution_error",
  });

  if (shouldTrace) {
    logWarn(
      "agent_tool_call_failed",
      traceContext,
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
        "error.type":
          error instanceof Error ? error.name : "tool_execution_error",
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Agent tool call failed",
    );
  }

  // MCP tool errors are expected outcomes — log as warning, not Sentry exception.
  if (!(error instanceof McpToolError)) {
    logException(
      error,
      "agent_tool_call_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
        ...getToolErrorAttributes(error),
      },
      "Agent tool call failed",
    );
  }

  throw error;
}
