import type { AgentTool } from "@mariozechner/pi-agent-core";
import { serializeGenAiAttribute } from "@/chat/logging";
import { setSpanAttributes, withSpan, type LogContext } from "@/chat/logging";
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import type { AssistantStatusSpec } from "@/chat/runtime/assistant-status";
import { buildToolStatus } from "@/chat/runtime/tool-status";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { SandboxExecutor } from "@/chat/sandbox/sandbox";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import type { ToolDefinition } from "@/chat/tools/definition";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";
import { resolveCredentialInjection } from "@/chat/tools/execution/inject-credentials";
import { normalizeToolResult } from "@/chat/tools/execution/normalize-result";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createAgentTools(
  tools: Record<string, ToolDefinition<any>>,
  sandbox: SkillSandbox,
  spanContext: LogContext,
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>,
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
      const traceToolContext = {
        ...spanContext,
        conversationId: spanContext.conversationId,
        turnId: spanContext.turnId,
        agentId: spanContext.agentId,
      };
      await onStatus?.(buildToolStatus(toolName, params));
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async () => {
          const parsed = params as Record<string, unknown>;

          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails = { ok: true };
              const toolResultAttribute =
                serializeGenAiAttribute(resultDetails);
              if (toolResultAttribute) {
                setSpanAttributes({
                  "gen_ai.tool.call.result": toolResultAttribute,
                });
              }
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails,
              };
            }

            const bashCommand =
              toolName === "bash" && typeof parsed.command === "string"
                ? parsed.command.trim()
                : "";
            const injection = resolveCredentialInjection(
              toolName,
              bashCommand,
              capabilityRuntime,
              sandbox,
            );

            const sandboxInput = buildSandboxInput(toolName, parsed);
            const isSandbox = Boolean(sandboxExecutor?.canExecute(toolName));
            const result = isSandbox
              ? await sandboxExecutor!.execute({
                  toolName,
                  input:
                    toolName === "bash" &&
                    (injection.headerTransforms || injection.env)
                      ? {
                          ...sandboxInput,
                          ...(injection.headerTransforms
                            ? { headerTransforms: injection.headerTransforms }
                            : {}),
                          ...(injection.env ? { env: injection.env } : {}),
                        }
                      : sandboxInput,
                })
              : await toolDef.execute(parsed as never, {
                  experimental_context: sandbox,
                });

            const normalized = normalizeToolResult(result, isSandbox);
            const toolResultAttribute = serializeGenAiAttribute(
              normalized.details,
            );
            if (toolResultAttribute) {
              setSpanAttributes({
                "gen_ai.tool.call.result": toolResultAttribute,
              });
            }
            return normalized;
          } catch (error) {
            handleToolExecutionError(
              error,
              toolName,
              normalizedToolCallId,
              shouldTrace,
              traceToolContext,
            );
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.description": toolDef.description,
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
