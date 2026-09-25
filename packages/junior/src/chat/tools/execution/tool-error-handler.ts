import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  type SetSpanAttributes,
} from "@/chat/logging";
import { PluginToolInputError } from "@sentry/junior-plugin-api";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import {
  getOAuthProviderErrorAttributes,
  OAuthProviderError,
} from "@/chat/oauth-response";
import {
  getMcpAwareTelemetryMessage,
  getMcpProviderErrorAttributes,
  McpProviderError,
  McpToolError,
} from "@/chat/mcp/errors";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { SlackActionError } from "@/chat/slack/client";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import {
  ToolActionRejectedError,
  ToolActionReviewLimitError,
  ToolActionReviewUnavailableError,
} from "@/chat/tool-support/action-review";

function isPluginToolInputError(error: unknown): boolean {
  return (
    error instanceof PluginToolInputError ||
    (error instanceof Error && error.name === "PluginToolInputError")
  );
}

/** Classify tool errors into stable observability types. */
function getToolErrorType(error: unknown): string {
  if (error instanceof McpToolError) return "tool_error";
  if (error instanceof McpProviderError) return "mcp_provider_error";
  if (error instanceof OAuthProviderError) return "oauth_provider_error";
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
    ...(error.apiError ? { "app.slack.api_error": error.apiError } : undefined),
    ...(error.detail ? { "app.slack.detail": error.detail } : undefined),
    ...(error.detailLine !== undefined
      ? { "app.slack.detail_line": error.detailLine }
      : undefined),
    ...(error.detailRule ? { "app.slack.detail_rule": error.detailRule } : undefined),
  };
}

/** Handle tool execution errors: set span attributes, log, and rethrow. */
export function handleToolExecutionError(
  error: unknown,
  toolName: string,
  toolCallId: string | undefined,
  shouldTrace: boolean,
  conversationPrivacy?: ConversationPrivacy,
  setExecutionSpanAttributes?: SetSpanAttributes,
): never {
  if (
    error instanceof ToolActionRejectedError ||
    error instanceof ToolActionReviewLimitError ||
    error instanceof ToolActionReviewUnavailableError
  ) {
    throw error;
  }
  const errorType = getToolErrorType(error);
  const errorMessage = getMcpAwareTelemetryMessage(error, conversationPrivacy);
  const errorAttributes = {
    "error.type": errorType,
    ...getMcpProviderErrorAttributes(error),
    ...getOAuthProviderErrorAttributes(error),
    ...(error instanceof PluginCredentialFailureError
      ? { "app.credential.provider": error.provider }
      : undefined),
  };
  if (setExecutionSpanAttributes) {
    setExecutionSpanAttributes(errorAttributes);
  } else {
    setSpanAttributes(errorAttributes);
  }

  if (error instanceof PluginCredentialFailureError) {
    if (shouldTrace) {
      logInfo("plugin.credential.rejected", {
        "app.credential.provider": error.provider,
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": toolName,
        ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : undefined),
        "error.type": errorType,
      });
    }
    throw error;
  }

  if (shouldTrace) {
    logWarn("agent.tool_call.failed", {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : undefined),
      ...errorAttributes,
      "exception.message": errorMessage,
    });
  }

  // Expected tool failures (MCP errors, model input errors) are not Sentry exceptions.
  const isExpectedToolFailure =
    error instanceof McpToolError ||
    error instanceof ToolInputError ||
    isPluginToolInputError(error);
  if (!isExpectedToolFailure) {
    logException(error, "agent.tool_call.failed", {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      ...(toolCallId ? { "gen_ai.tool.call.id": toolCallId } : undefined),
      ...errorAttributes,
      ...getToolErrorAttributes(error),
    });
  }

  throw error;
}
