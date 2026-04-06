import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { serializeGenAiAttribute } from "@/chat/logging";
import {
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import { formatToolStatusWithInput } from "@/chat/runtime/tool-status";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { SandboxExecutor } from "@/chat/sandbox/sandbox";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { McpToolError } from "@/chat/mcp/tool-manager";
import { SlackActionError } from "@/chat/slack/client";
import type { ToolDefinition } from "@/chat/tools/definition";

function toToolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isStructuredToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
  details: unknown;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(content) &&
    content.every((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text") {
        return typeof record.text === "string";
      }
      if (record.type === "image") {
        return (
          typeof record.data === "string" && typeof record.mimeType === "string"
        );
      }
      return false;
    }) &&
    "details" in value
  );
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

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  spanContext: LogContext,
  onStatus?: (status: string) => void | Promise<void>,
  sandboxExecutor?: SandboxExecutor,
  capabilityRuntime?: SkillCapabilityRuntime,
  hooks?: {
    onToolCall?: (toolName: string) => void;
  },
): AgentTool[] {
  const shouldTrace = shouldEmitDevAgentTrace();
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    execute: async (toolCallId: unknown, params: unknown) => {
      const normalizedToolCallId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : undefined;
      const toolArgumentsAttribute = serializeGenAiAttribute(params);
      hooks?.onToolCall?.(toolName);
      const toolStartedAt = Date.now();
      const traceToolContext = {
        ...spanContext,
        conversationId: spanContext.conversationId,
        turnId: spanContext.turnId,
        agentId: spanContext.agentId,
      };
      await onStatus?.(`${formatToolStatusWithInput(toolName, params)}...`);
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async () => {
          // pi-agent-core validates tool args with AJV (via
          // validateToolArguments) before calling execute(), so no
          // client-side validation is needed here.
          const parsed = params as Record<string, unknown>;

          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails = { ok: true };
              const durationMs = Date.now() - toolStartedAt;
              const toolResultAttribute =
                serializeGenAiAttribute(resultDetails);
              setSpanAttributes({
                "app.ai.tool_duration_ms": durationMs,
                "app.ai.tool_outcome": "success",
                ...(toolResultAttribute
                  ? { "gen_ai.tool.call.result": toolResultAttribute }
                  : {}),
              });
              setSpanStatus("ok");
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails,
              };
            }

            const injectedHeaders =
              toolName === "bash"
                ? capabilityRuntime?.getTurnHeaderTransforms()
                : undefined;
            const injectedEnv =
              toolName === "bash" ? capabilityRuntime?.getTurnEnv() : undefined;
            const bashCommand =
              toolName === "bash" && typeof parsed.command === "string"
                ? parsed.command.trim()
                : "";
            const isCustomBashCommand =
              toolName === "bash" && /^jr-rpc(?:\s|$)/.test(bashCommand);
            const shouldLogCredentialInjection =
              toolName === "bash" &&
              !isCustomBashCommand &&
              Boolean(injectedHeaders && injectedHeaders.length > 0);
            if (shouldLogCredentialInjection) {
              const headerDomains = (injectedHeaders ?? []).map(
                (transform) => transform.domain,
              );
              logInfo(
                "credential_inject_start",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name,
                  "app.credential.delivery": "header_transform",
                  "app.credential.header_domains": headerDomains,
                },
                "Injecting scoped credential headers for sandbox command",
              );
            }

            const hasBashCredentials = injectedHeaders || injectedEnv;
            const sandboxInput =
              toolName === "bash"
                ? { command: String(parsed.command ?? "") }
                : toolName === "readFile"
                  ? { path: String(parsed.path ?? "") }
                  : toolName === "writeFile"
                    ? {
                        path: String(parsed.path ?? ""),
                        content: String(parsed.content ?? ""),
                      }
                    : parsed;
            const result = sandboxExecutor?.canExecute(toolName)
              ? await sandboxExecutor.execute({
                  toolName,
                  input:
                    toolName === "bash" && hasBashCredentials
                      ? {
                          ...sandboxInput,
                          ...(injectedHeaders
                            ? { headerTransforms: injectedHeaders }
                            : {}),
                          ...(injectedEnv ? { env: injectedEnv } : {}),
                        }
                      : sandboxInput,
                })
              : await toolDef.execute(parsed as never, {
                  experimental_context: sandbox,
                });
            const resultDetails =
              sandboxExecutor?.canExecute(toolName) &&
              result &&
              typeof result === "object" &&
              "result" in result
                ? (result as { result: unknown }).result
                : result;
            const durationMs = Date.now() - toolStartedAt;
            const structuredToolResult = isStructuredToolExecutionResult(
              resultDetails,
            )
              ? resultDetails
              : undefined;
            const toolResultAttribute = serializeGenAiAttribute(
              structuredToolResult?.details ?? resultDetails,
            );
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "success",
              ...(toolResultAttribute
                ? { "gen_ai.tool.call.result": toolResultAttribute }
                : {}),
            });
            setSpanStatus("ok");
            if (structuredToolResult) {
              return structuredToolResult;
            }
            return {
              content: [
                { type: "text", text: toToolContentText(resultDetails) },
              ],
              details: resultDetails,
            };
          } catch (error) {
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "error",
              "error.type":
                error instanceof Error ? error.name : "tool_execution_error",
            });
            setSpanStatus("error");
            if (shouldTrace) {
              logWarn(
                "agent_tool_call_failed",
                traceToolContext,
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "execute_tool",
                  "gen_ai.tool.name": toolName,
                  ...(normalizedToolCallId
                    ? { "gen_ai.tool.call.id": normalizedToolCallId }
                    : {}),
                  "app.ai.tool_duration_ms": durationMs,
                  "app.ai.tool_outcome": "error",
                  "error.type":
                    error instanceof Error
                      ? error.name
                      : "tool_execution_error",
                  "error.message":
                    error instanceof Error ? error.message : String(error),
                },
                "Agent tool call failed",
              );
            }
            // MCP tool errors are expected outcomes (server rejected input,
            // tool returned isError) — log as warning, not Sentry exception.
            if (!(error instanceof McpToolError)) {
              logException(
                error,
                "agent_tool_call_failed",
                {},
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "execute_tool",
                  "gen_ai.tool.name": toolName,
                  ...(normalizedToolCallId
                    ? { "gen_ai.tool.call.id": normalizedToolCallId }
                    : {}),
                  "app.ai.tool_duration_ms": durationMs,
                  ...getToolErrorAttributes(error),
                },
                "Agent tool call failed",
              );
            }
            throw error;
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          ...(normalizedToolCallId
            ? { "gen_ai.tool.call.id": normalizedToolCallId }
            : {}),
          ...(toolArgumentsAttribute
            ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute }
            : {}),
        },
      );
    },
  }));
}
