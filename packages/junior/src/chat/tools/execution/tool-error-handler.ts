import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  type LogContext,
} from "@/chat/logging";
import { AgentPluginToolInputError } from "@sentry/junior-plugin-api";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { getMcpAwareErrorMessage, McpToolError } from "@/chat/mcp/errors";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { SlackActionError } from "@/chat/slack/client";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

function isPluginToolInputError(error: unknown): boolean {
  return (
    error instanceof AgentPluginToolInputError ||
    (error instanceof Error && error.name === "AgentPluginToolInputError")
  );
}

/** Classify tool errors into stable observability types. */
function getToolErrorType(error: unknown): string {
  if (error instanceof McpToolError) return "tool_error";
  if (error instanceof ToolInputError || isPluginToolInputError(error)) {
    return "tool_input_error";
  }
  return error instanceof Error ? error.name : "tool_execution_error";
}

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
  const errorType = getToolErrorType(error);
  const errorMessage = getMcpAwareErrorMessage(error);
  setSpanAttributes({
    "error.type": errorType,
    ...(error instanceof PluginCredentialFailureError
      ? { "app.credential.provider": error.provider }
      : {}),
  });

  if (error instanceof PluginCredentialFailureError) {
    if (shouldTrace) {
      logInfo(
        "plugin_credential_rejected",
        traceContext,
        {
          "app.credential.provider": error.provider,
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
          "error.type": errorType,
        },
        "Plugin credentials were rejected during tool execution",
      );
    }
    throw error;
  }

  if (shouldTrace) {
    logWarn(
      "agent_tool_call_failed",
      traceContext,
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : {}),
        "error.type": errorType,
        "exception.message": errorMessage,
      },
      "Agent tool call failed",
    );
  }

  // Expected tool failures (MCP errors, model input errors) are not Sentry exceptions.
  const isExpectedToolFailure =
    error instanceof McpToolError ||
    error instanceof ToolInputError ||
    isPluginToolInputError(error);
  if (!isExpectedToolFailure) {
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
