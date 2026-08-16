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
import { shouldEmitDevAgentTrace } from "@/chat/runtime/dev-agent-trace";
import {
  AuthorizationFlowDisabledError,
  AuthorizationPauseError,
} from "@/chat/services/auth-pause";
import type { PluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";
import { buildReportedProgressStatus } from "@/chat/runtime/report-progress";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SandboxTools } from "@/chat/sandbox/sandbox";
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
import {
  reviewToolAction,
  ToolActionRejectedError,
  type ToolActionReview,
} from "@/chat/tool-support/action-review";

/** Wrap tool definitions into Pi Agent tool objects with logging, validation, and sandbox execution. */
export function createPiAgentTools(
  tools: Record<string, AnyToolDefinition>,
  sandbox: SkillSandbox,
  spanContext: LogContext,
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>,
  sandboxTools?: SandboxTools,
  pluginAuthOrchestration?: PluginAuthOrchestration,
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>,
  agentHooks?: PluginHookRunner,
  conversationPrivacy?: ConversationPrivacy,
  onToolResult?: (report: ToolExecutionReport) => void | Promise<void>,
  actionReview?: ToolActionReview,
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
    options: { exposePrivate?: boolean; privateMetadata?: boolean } = {},
  ) =>
    effectiveConversationPrivacy === "private" && !options.exposePrivate
      ? options.privateMetadata
        ? serializeGenAiAttribute(toGenAiPayloadMetadata(payload))
        : undefined
      : serializeGenAiAttribute(payload);
  const notifyToolResult = async (report: ToolExecutionReport) => {
    try {
      await onToolResult?.(report);
    } catch (error) {
      logWarn("tool.result.observer.failed", {
        "gen_ai.tool.name": report.toolName,
        "exception.message":
          error instanceof Error ? error.message : String(error),
      });
    }
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
    toolCallId: string;
    params: Record<string, unknown>;
    signal: AbortSignal | undefined;
    setSpanAttributes: SetSpanAttributes;
    toolDef: AnyToolDefinition;
    toolName: string;
  }) => {
    const { toolCallId, params, signal, setSpanAttributes, toolDef, toolName } =
      args;
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
    const executionInput = {
      ...toolInput,
      ...(Object.keys(beforeTool.env).length > 0
        ? {
            env: {
              ...(toolInput.env &&
              typeof toolInput.env === "object" &&
              !Array.isArray(toolInput.env)
                ? toolInput.env
                : {}),
              ...beforeTool.env,
            },
          }
        : {}),
    };
    await onToolCall?.(toolCallId, toolName, toolInput);
    try {
      const assessment = await reviewToolAction(
        toolCallId,
        toolName,
        toolDef,
        toolInput,
        actionReview,
        signal,
      );
      if (assessment) {
        setSpanAttributes({
          "app.guardian.decision": assessment.decision,
          "app.guardian.risk_level": assessment.riskLevel,
          "app.guardian.user_authorization": assessment.userAuthorization,
        });
      }
    } catch (error) {
      if (error instanceof ToolActionRejectedError) {
        setSpanAttributes({
          "app.guardian.decision": error.decision,
          ...(error.riskLevel
            ? { "app.guardian.risk_level": error.riskLevel }
            : {}),
          ...(error.userAuthorization
            ? {
                "app.guardian.user_authorization": error.userAuthorization,
              }
            : {}),
        });
      }
      throw error;
    }
    const sandboxInput = buildSandboxInput(toolName, executionInput);
    const isSandbox = Boolean(sandboxTools?.supports(toolName));
    const result = isSandbox
      ? await sandboxTools!.execute({
          toolName,
          input: sandboxInput,
          ...(signal ? { signal } : {}),
          ...(toolName === "grep" || toolName === "findFiles"
            ? { setToolCallSpanAttributes: setSpanAttributes }
            : {}),
        })
      : await toolDef.execute(executionInput, {
          experimental_context: sandbox,
          ...(signal ? { signal } : {}),
          conversationPrivacy: effectiveConversationPrivacy,
          toolCallId,
        });

    const normalized = normalizeToolResult(result, {
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
        logWarn("tool.private.trace_projection.failed", {
          "error.type": error instanceof Error ? error.name : typeof error,
          "gen_ai.tool.name": toolName,
        });
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
            {
              exposePrivate: hasProjectedPrivateResult,
              privateMetadata: true,
            },
          );
    if (toolResultAttribute) {
      setSpanAttributes({
        "gen_ai.tool.call.result": toolResultAttribute,
        ...(hasProjectedPrivateResult ? privateTraceResultAttributes() : {}),
        ...toGenAiPayloadTraceAttributes(
          "gen_ai.tool.call.result",
          resultAttributeValue,
        ),
      });
    }
    // Only completed executions reach this projection. Thrown tool failures use
    // Pi's error channel, so success is runtime metadata rather than a field in
    // the canonical tool output.
    await notifyToolResult({
      ok: true,
      params: toolInput,
      result: resultAttributeValue,
      toolCallId,
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
    executionMode:
      toolDef.approvalMode === "auto" || toolDef.approvalMode === "review"
        ? "sequential"
        : toolDef.executionMode,
    execute: async (
      toolCallId: unknown,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      if (typeof toolCallId !== "string" || toolCallId.length === 0) {
        throw new Error("Pi tool execution requires a non-empty tool call id.");
      }
      // Intentional OTel deviation: private traces put Junior's safe metadata
      // here, with flattened gen_ai.tool.call.arguments.* extension attributes.
      const toolArgumentsAttribute = serializeToolPayload(params, {
        privateMetadata: true,
      });
      const toolArgumentsMetadata = toGenAiPayloadTraceAttributes(
        "gen_ai.tool.call.arguments",
        params,
      );
      const result = await withSpan(
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
                "gen_ai.tool.dispatcher.name": EXECUTE_TOOL_NAME,
                "gen_ai.tool.description":
                  resolvedCatalogCall.definition.description,
                "gen_ai.tool.name": resolvedCatalogCall.toolName,
              });
              const catalogCall = prepareCatalogToolCall(resolvedCatalogCall);
              executionParams = catalogCall.arguments;
              await reportStatus(executionToolName, executionParams);
              return await executeDefinition({
                toolCallId,
                params: catalogCall.arguments,
                signal,
                setSpanAttributes,
                toolDef: catalogCall.definition,
                toolName: catalogCall.toolName,
              });
            }

            await reportStatus(executionToolName, executionParams);
            return await executeDefinition({
              toolCallId,
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
              toolCallId,
              toolName: executionToolName,
            });
            if (
              error instanceof AuthorizationPauseError ||
              error instanceof AuthorizationFlowDisabledError
            ) {
              throw error;
            }
            if (error instanceof ToolActionRejectedError) {
              return error;
            }
            handleToolExecutionError(
              error,
              executionToolName,
              toolCallId,
              shouldTrace,
              effectiveConversationPrivacy,
              setSpanAttributes,
            );
          }
        },
        {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          "gen_ai.tool.description": toolDef.description,
          "gen_ai.tool.type": "function",
          ...toolArgumentsMetadata,
          "gen_ai.tool.call.id": toolCallId,
          ...(toolArgumentsAttribute
            ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute }
            : {}),
        },
      );
      if (result instanceof ToolActionRejectedError) {
        throw result;
      }
      return result;
    },
  }));
}
