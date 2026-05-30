import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import { serializeGenAiAttribute } from "@/chat/logging";
import { setSpanAttributes, withSpan, type LogContext } from "@/chat/logging";
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
import type { ToolDefinition } from "@/chat/tools/definition";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";
import { normalizeToolResult } from "@/chat/tools/execution/normalize-result";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import type { AgentPluginHookRunner } from "@/chat/plugins/agent-hooks";

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  spanContext: LogContext,
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>,
  sandboxExecutor?: SandboxExecutor,
  pluginAuthOrchestration?: PluginAuthOrchestration,
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void,
  agentHooks?: AgentPluginHookRunner,
  conversationPrivacy?: ConversationPrivacy,
): AgentTool[] {
  const shouldTrace = shouldEmitDevAgentTrace();
  const effectiveConversationPrivacy = conversationPrivacy ?? "private";
  const serializeToolPayload = (payload: unknown) =>
    serializeGenAiAttribute(
      effectiveConversationPrivacy === "private"
        ? toGenAiPayloadMetadata(payload)
        : payload,
    );
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    prepareArguments: toolDef.prepareArguments,
    executionMode: toolDef.executionMode,
    execute: async (toolCallId: unknown, params: unknown) => {
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
            onToolCall?.(toolName, toolInput);
            const bashCommand =
              toolName === "bash" && typeof toolInput.command === "string"
                ? toolInput.command.trim()
                : "";

            const sandboxInput = buildSandboxInput(toolName, toolInput);
            const isSandbox = Boolean(sandboxExecutor?.canExecute(toolName));
            const result = isSandbox
              ? await sandboxExecutor!.execute({
                  toolName,
                  input: sandboxInput,
                })
              : await toolDef.execute(toolInput as never, {
                  experimental_context: sandbox,
                });

            const normalized = normalizeToolResult(result, isSandbox);
            if (bashCommand && pluginAuthOrchestration) {
              await pluginAuthOrchestration.handleCommandFailure({
                activeSkill: sandbox.getActiveSkill(),
                command: bashCommand,
                details: normalized.details,
              });
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
            return normalized;
          } catch (error) {
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
            );
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "app.conversation.privacy": effectiveConversationPrivacy,
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.description": toolDef.description,
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
