import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  toGenAiPayloadMetadata,
  toGenAiPayloadTraceAttributes,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import { serializeGenAiAttribute } from "@/chat/logging";
import {
  logWarn,
  withSpan,
  type LogContext,
  type SetSpanAttributes,
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
import type { ToolExecutionReport } from "@/chat/tool-support/tool-execution-report";
import { privateTraceResultAttributes } from "@/chat/tool-support/private-trace-result";
import {
  prepareCatalogToolCall,
  resolveCatalogToolCall,
} from "@/chat/tool-support/catalog-tool-call";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";
import { normalizeToolResult } from "@/chat/tool-support/normalize-result";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import type { PluginHookRunner } from "@/chat/plugins/agent-hooks";
import {
  createExecuteToolTool,
  EXECUTE_TOOL_NAME,
} from "@/chat/tools/execute-tool";
import { planToolExposure } from "@/chat/tool-exposure";
import {
  createSearchToolsTool,
  SEARCH_TOOLS_NAME,
} from "@/chat/tools/search-tools";

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createPiAgentTools(
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
  const plannedTools = planToolExposure(tools);
  const visibleTools: Record<string, AnyToolDefinition> = {
    ...plannedTools.directTools,
  };
  if (visibleTools[SEARCH_TOOLS_NAME] || visibleTools[EXECUTE_TOOL_NAME]) {
    throw new Error(
      `${SEARCH_TOOLS_NAME} and ${EXECUTE_TOOL_NAME} are reserved for tool catalog discovery`,
    );
  }
  visibleTools[SEARCH_TOOLS_NAME] = createSearchToolsTool(
    plannedTools.catalogTools,
  );
  visibleTools[EXECUTE_TOOL_NAME] = createExecuteToolTool();
  const shouldTrace = shouldEmitDevAgentTrace();
  const effectiveConversationPrivacy = conversationPrivacy ?? "private";
  const serializeToolPayload = (
    payload: unknown,
    options: { exposePrivate?: boolean } = {},
  ) =>
    serializeGenAiAttribute(
      effectiveConversationPrivacy === "private" && !options.exposePrivate
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
  const toolResultOk = (details: unknown): boolean => {
    if (
      details &&
      typeof details === "object" &&
      typeof (details as { ok?: unknown }).ok === "boolean"
    ) {
      return (details as { ok: boolean }).ok;
    }
    return true;
  };
  const reportedToolResult = (
    result: unknown,
    isSandbox: boolean,
    normalized: ReturnType<typeof normalizeToolResult>,
  ): unknown => {
    const unwrapped = isSandbox
      ? (result as { result: unknown }).result
      : result;
    if (
      unwrapped &&
      typeof unwrapped === "object" &&
      !Array.isArray(unwrapped) &&
      "content" in unwrapped &&
      !("details" in unwrapped)
    ) {
      return { content: normalized.content };
    }
    return normalized.details;
  };
  const executeDefinition = async (args: {
    normalizedToolCallId: string | undefined;
    params: Record<string, unknown>;
    signal: AbortSignal | undefined;
    setSpanAttributes: SetSpanAttributes;
    toolDef: AnyToolDefinition;
    toolName: string;
  }) => {
    const {
      normalizedToolCallId,
      params,
      signal,
      setSpanAttributes,
      toolDef,
      toolName,
    } = args;
    if (typeof toolDef.execute !== "function") {
      throw new Error(`Tool ${toolName} does not define an executor.`);
    }

    const beforeTool = agentHooks
      ? await agentHooks.beforeToolExecute({
          name: toolName,
          input: params,
        })
      : { input: params, env: {} };
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
          ...(normalizedToolCallId ? { toolCallId: normalizedToolCallId } : {}),
        });

    const normalized = normalizeToolResult(result, isSandbox, {
      requireStructuredResult: Boolean(toolDef.outputSchema),
      toolName,
    });
    if (isSandbox && pluginAuthOrchestration) {
      await pluginAuthOrchestration.maybeHandleAuthSignal(normalized.details);
    }
    const resultAttributeValue = reportedToolResult(
      result,
      isSandbox,
      normalized,
    );
    let projectedPrivateResult: unknown;
    let hasProjectedPrivateResult = false;
    if (
      effectiveConversationPrivacy === "private" &&
      toolDef.privateTraceResult
    ) {
      try {
        projectedPrivateResult =
          toolDef.privateTraceResult(resultAttributeValue);
        hasProjectedPrivateResult = projectedPrivateResult !== undefined;
      } catch (error) {
        logWarn(
          "tool_private_trace_projection_failed",
          spanContext,
          {
            "error.type": error instanceof Error ? error.name : typeof error,
            "gen_ai.tool.name": toolName,
          },
          "Tool private trace projection failed",
        );
      }
    }
    const toolResultAttribute =
      effectiveConversationPrivacy === "private" &&
      toolDef.privateTraceResult &&
      !hasProjectedPrivateResult
        ? undefined
        : serializeToolPayload(
            hasProjectedPrivateResult
              ? projectedPrivateResult
              : resultAttributeValue,
            { exposePrivate: hasProjectedPrivateResult },
          );
    if (toolResultAttribute) {
      setSpanAttributes({
        "gen_ai.tool.call.result": toolResultAttribute,
        ...(hasProjectedPrivateResult ? privateTraceResultAttributes() : {}),
        ...toGenAiPayloadTraceAttributes(
          "app.ai.tool.call.result",
          resultAttributeValue,
        ),
      });
    }
    await notifyToolResult({
      ok: toolResultOk(normalized.details),
      params: toolInput,
      result: resultAttributeValue,
      toolName,
    });
    return normalized;
  };
  const reportStatus = async (
    executionToolName: string,
    params: Record<string, unknown>,
  ) => {
    if (executionToolName !== "reportProgress") {
      return;
    }
    const status = buildReportedProgressStatus(params);
    if (status) {
      await onStatus?.(status);
    }
  };
  return Object.entries(visibleTools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema as AgentTool["parameters"],
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
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async (setSpanAttributes) => {
          const parsed = params as Record<string, unknown>;
          let executionToolName = toolName;
          let executionParams = parsed;

          try {
            if (toolName === EXECUTE_TOOL_NAME) {
              const resolvedCatalogCall = resolveCatalogToolCall(
                parsed,
                plannedTools.catalogTools,
              );
              executionToolName = resolvedCatalogCall.toolName;
              executionParams = resolvedCatalogCall.arguments;
              setSpanAttributes({
                "app.ai.tool.dispatcher.name": EXECUTE_TOOL_NAME,
                "gen_ai.tool.description":
                  resolvedCatalogCall.definition.description,
                "gen_ai.tool.name": resolvedCatalogCall.toolName,
              });
              const catalogCall = prepareCatalogToolCall(resolvedCatalogCall);
              executionParams = catalogCall.arguments;
              await reportStatus(executionToolName, executionParams);
              return await executeDefinition({
                normalizedToolCallId,
                params: catalogCall.arguments,
                signal,
                setSpanAttributes,
                toolDef: catalogCall.definition,
                toolName: catalogCall.toolName,
              });
            }

            await reportStatus(executionToolName, executionParams);
            return await executeDefinition({
              normalizedToolCallId,
              params: parsed,
              signal,
              setSpanAttributes,
              toolDef,
              toolName,
            });
          } catch (error) {
            await notifyToolResult({
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              params: executionParams,
              toolName: executionToolName,
            });
            if (
              error instanceof AuthorizationPauseError ||
              error instanceof AuthorizationFlowDisabledError
            ) {
              throw error;
            }
            handleToolExecutionError(
              error,
              executionToolName,
              normalizedToolCallId,
              shouldTrace,
              spanContext,
              effectiveConversationPrivacy,
              setSpanAttributes,
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
