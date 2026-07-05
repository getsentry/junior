import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import { serializeGenAiAttribute } from "@/chat/logging";
import {
  logWarn,
  setSpanAttributes,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import type { PluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import { buildReportedProgressStatus } from "@/chat/runtime/report-progress";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SandboxExecutor } from "@/chat/sandbox/sandbox";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";
import { normalizeToolResult } from "@/chat/tools/execution/normalize-result";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import type { PluginHookRunner } from "@/chat/plugins/agent-hooks";

export interface ToolExecutionReport {
  error?: string;
  ok: boolean;
  params: Record<string, unknown>;
  result?: unknown;
  toolName: string;
}

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createAgentTools(
  tools: Record<string, AnyToolDefinition>,
  sandbox: SkillSandbox,
  spanContext: LogContext,
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>,
  sandboxExecutor?: SandboxExecutor,
  pluginAuthOrchestration?: PluginAuthOrchestration,
  onToolCall?: (
    toolName: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>,
  agentHooks?: PluginHookRunner,
  conversationPrivacy?: ConversationPrivacy,
  onToolResult?: (report: ToolExecutionReport) => void | Promise<void>,
): AgentTool[] {
  const shouldTrace = shouldEmitDevAgentTrace();
  const effectiveConversationPrivacy = conversationPrivacy ?? "private";
  const serializeToolPayload = (payload: unknown) =>
    serializeGenAiAttribute(
      effectiveConversationPrivacy === "private"
        ? toGenAiPayloadMetadata(payload)
        : payload,
    );
  const notifyToolResult = async (report: ToolExecutionReport) => {
    try {
      await onToolResult?.(report);
    } catch (error) {
      logWarn(
        "tool_result_observer_failed",
        spanContext,
        {
          "gen_ai.tool.name": report.toolName,
          "exception.message":
            error instanceof Error ? error.message : String(error),
        },
        "Tool result observer failed",
      );
    }
  };
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    prepareArguments: toolDef.prepareArguments,
    executionMode: toolDef.executionMode,
    execute: async (
      toolCallId: unknown,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      const normalizedToolCallId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : undefined;
      const toolArgumentsAttribute = serializeToolPayload(params);
      const toolArgumentsMetadata = toGenAiPayloadTraceAttributes(
        "app.ai.tool.call.arguments",
        params,
      );
      if (toolName === "reportProgress") {
        const status = buildReportedProgressStatus(params);
        if (status) {
          await onStatus?.(status);
        }
      }
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async () => {
          const parsed = params as Record<string, unknown>;

          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails = { ok: true };
              const toolResultAttribute = serializeToolPayload(resultDetails);
              if (toolResultAttribute) {
                setSpanAttributes({
                  "gen_ai.tool.call.result": toolResultAttribute,
                  ...toGenAiPayloadTraceAttributes(
                    "app.ai.tool.call.result",
                    resultDetails,
                  ),
                });
              }
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails,
              };
            }

            const beforeTool = agentHooks
              ? await agentHooks.beforeToolExecute({
                  name: toolName,
                  input: parsed,
                })
              : { input: parsed, env: {} };
            const toolInput = beforeTool.input;
            await onToolCall?.(toolName, toolInput);
            const sandboxInput = buildSandboxInput(toolName, toolInput);
            const isSandbox = Boolean(sandboxExecutor?.canExecute(toolName));
            const result = isSandbox
              ? await sandboxExecutor!.execute({
                  toolName,
                  input: sandboxInput,
                  ...(signal ? { signal } : {}),
                })
              : await toolDef.execute(toolInput, {
                  experimental_context: sandbox,
                  ...(signal ? { signal } : {}),
                  conversationPrivacy: effectiveConversationPrivacy,
                  ...(normalizedToolCallId
                    ? { toolCallId: normalizedToolCallId }
                    : {}),
                });

            const normalized = normalizeToolResult(result, isSandbox);
            if (isSandbox && pluginAuthOrchestration) {
              await pluginAuthOrchestration.maybeHandleAuthSignal(
                normalized.details,
              );
            }
            const resultAttributeValue =
              normalized.details &&
              typeof normalized.details === "object" &&
              "rawResult" in normalized.details &&
              (normalized.details as { rawResult?: unknown }).rawResult !==
                undefined
                ? (normalized.details as { rawResult: unknown }).rawResult
                : normalized.details;
            const toolResultAttribute =
              serializeToolPayload(resultAttributeValue);
            if (toolResultAttribute) {
              setSpanAttributes({
                "gen_ai.tool.call.result": toolResultAttribute,
                ...toGenAiPayloadTraceAttributes(
                  "app.ai.tool.call.result",
                  resultAttributeValue,
                ),
              });
            }
            await notifyToolResult({
              ok: true,
              params: toolInput,
              result: resultAttributeValue,
              toolName,
            });
            return normalized;
          } catch (error) {
            await notifyToolResult({
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              params: parsed,
              toolName,
            });
            if (
              error instanceof AuthorizationPauseError ||
              error instanceof AuthorizationFlowDisabledError
            ) {
              throw error;
            }
            handleToolExecutionError(
              error,
              toolName,
              normalizedToolCallId,
              shouldTrace,
              spanContext,
              effectiveConversationPrivacy,
            );
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.description": toolDef.description,
          "gen_ai.tool.type": "extension",
          ...toolArgumentsMetadata,
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
