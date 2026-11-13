import { isDeepStrictEqual } from "node:util";
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
import {
  buildPlanStatus,
  buildReportedProgressStatus,
} from "@/chat/runtime/report-progress";
import type { AssistantStatusSpec } from "@/chat/slack/assistant-thread/status";
import type { SandboxTools } from "@/chat/sandbox/sandbox";
import type { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import {
  disabledToolMessage,
  type AnyToolDefinition,
} from "@/chat/tools/definition";
import type { ToolExecutionReport } from "@/chat/tool-support/tool-execution-report";
import { privateTraceResultAttributes } from "@/chat/tool-support/private-trace-result";
import {
  prepareCatalogToolCall,
  resolveCatalogToolCall,
} from "@/chat/tool-support/catalog-tool-call";
import { buildSandboxInput } from "@/chat/tools/execution/build-sandbox-input";
import { normalizeToolResult } from "@/chat/tool-support/normalize-result";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { PluginHookRunner } from "@/chat/plugins/agent-hooks";
import {
  renderToolResultNudge,
  type ToolResultNudge,
} from "@/chat/plugins/after-tool-hooks";
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
  reviewToolActions,
  ToolActionRejectedError,
  type ToolAction,
  type ToolActionReview,
  type ToolActionReviewResult,
} from "@/chat/guardian/gate";
import {
  getToolActionRejectionMarker,
  type ToolActionRejectionMarker,
} from "@/chat/guardian/history";
import { CODEMODE_TOOL_NAME } from "@/chat/codemode/result";
import {
  createCodeModeTool,
  type CodeModeToolOptions,
} from "@/chat/codemode/tool";
import { makeStructuredToolOutput } from "@/chat/tool-support/structured-result";
import { capToolResult } from "@/chat/tool-support/result-cap";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";
import type { ConversationModelCost } from "@/chat/core-model";

/**
 * How long a preempted tool may take to return its own aborted result. Keep it
 * below the agent's abort settle grace, so the parked turn sees the result.
 */
const TOOL_ABORT_SETTLE_GRACE_MS = 2_000;

/**
 * Stop waiting for a tool shortly after the host preempts it. A tool that
 * ignores the signal must not hold the turn past its deadline, or the parked
 * turn loses the attempt. Work that keeps running is detached; its outcome is
 * unknown.
 */
async function untilPreempted<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const preempted = new Promise<never>((_, reject) => {
    onAbort = () => {
      timer = setTimeout(
        () => reject(signal.reason),
        TOOL_ABORT_SETTLE_GRACE_MS,
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, preempted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    // The attempt is already reported; a late failure has no reader.
    work.catch(() => undefined);
  }
}

type NormalizedToolResult = ReturnType<typeof normalizeToolResult>;

/**
 * Add plugin guidance after the tool's own content. Details stay the same, so
 * structured (JSON) output is not changed.
 */
function withToolResultNudges(
  result: NormalizedToolResult,
  nudges: ToolResultNudge[],
): NormalizedToolResult {
  if (nudges.length === 0) return result;
  return {
    ...result,
    content: [
      ...result.content,
      ...nudges.map((nudge) => ({
        type: "text" as const,
        text: renderToolResultNudge(nudge),
      })),
    ],
  };
}

/** Services that every tool call uses, for direct, catalog, and script calls. */
export interface ToolPipelineOptions {
  /** Tools that `executeTool` may run. */
  catalogTools: Record<string, AnyToolDefinition>;
  sandbox: SkillSandbox;
  spanContext: LogContext;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
  sandboxTools?: SandboxTools;
  pluginAuthOrchestration?: PluginAuthOrchestration;
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>;
  agentHooks?: PluginHookRunner;
  conversationPrivacy?: ConversationPrivacy;
  onToolResult?: (report: ToolExecutionReport) => void | Promise<void>;
  actionReview?: ToolActionReview;
  /** Keeps the full text of a model-facing result that was cut. */
  workspace?: Pick<SandboxWorkspace, "writeFiles">;
}

/** One tool call that a Code Mode script made. */
export interface ScriptToolCall {
  /** `<codemode call id>/c<n>`. */
  toolCallId: string;
  toolName: string;
  tool: AnyToolDefinition;
  /** What the script passed, after a JSON round trip. */
  input: unknown;
  signal: AbortSignal;
  /**
   * Return the action review result for the validated, hook-adjusted action.
   * The caller reviews the calls of one VM drain as one batch, and may hold
   * the call here until it can run.
   */
  review(action: ToolAction): Promise<ToolActionReviewResult>;
}

/**
 * Outcome of one script tool call. `preempted` means the host aborted the
 * call, so whether it ran is unknown. An authorization pause throws.
 */
export type ScriptToolCallOutcome =
  | { status: "ok"; result: NormalizedToolResult; nudges: ToolResultNudge[] }
  | { status: "preempted" }
  | {
      status: "rejected";
      error: ToolActionRejectedError;
      marker?: ToolActionRejectionMarker;
    }
  | { status: "error"; error: Error };

/** Result of one traced tool call. Other failures throw. */
type TracedToolCall =
  | { kind: "completed"; result: NormalizedToolResult }
  | { kind: "preempted"; result: NormalizedToolResult & { isError: false } }
  | { kind: "rejected"; error: ToolActionRejectedError };

/** The tool and input that a traced call runs, after dispatch resolves it. */
interface ToolCallTarget {
  toolName: string;
  params: Record<string, unknown>;
}

/** A tool call after checks and plugin hooks, ready for action review. */
interface PreparedToolCall {
  action: ToolAction;
  /** Tool input with hook-injected env. Execution only; review never sees it. */
  executionInput: Record<string, unknown>;
}

/**
 * Create the path every tool call takes: argument checks, plugin hooks,
 * action review, credentials and auth handling, then the executor, under one
 * `gen_ai.execute_tool` span.
 */
export function createToolPipeline(options: ToolPipelineOptions) {
  const {
    sandbox,
    spanContext,
    onStatus,
    sandboxTools,
    pluginAuthOrchestration,
    onToolCall,
    agentHooks,
    conversationPrivacy,
    onToolResult,
    actionReview,
    workspace,
  } = options;
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
  const prepareCall = async (args: {
    toolCallId: string;
    params: Record<string, unknown>;
    toolDef: AnyToolDefinition;
    toolName: string;
  }): Promise<PreparedToolCall> => {
    const { toolCallId, params, toolDef, toolName } = args;
    if (typeof toolDef.execute !== "function") {
      throw new Error(`Tool ${toolName} does not define an executor.`);
    }
    // Disabled tools stay in the tool list. Reject them before hooks, action
    // review, and the executor run.
    if (toolDef.disabledReason) {
      throw new ToolInputError(
        disabledToolMessage(toolName, toolDef.disabledReason),
      );
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
                : undefined),
              ...beforeTool.env,
            },
          }
        : undefined),
    };
    await onToolCall?.(toolCallId, toolName, toolInput);
    return {
      action: { toolCallId, toolName, tool: toolDef, input: toolInput },
      executionInput,
    };
  };
  const executeReviewed = async (args: {
    prepared: PreparedToolCall;
    review: ToolActionReviewResult;
    signal: AbortSignal | undefined;
    setSpanAttributes: SetSpanAttributes;
  }) => {
    const { prepared, review, signal, setSpanAttributes } = args;
    const { executionInput } = prepared;
    const {
      toolCallId,
      toolName,
      tool: toolDef,
      input: toolInput,
    } = prepared.action;
    if (!review.allowed) {
      const { error } = review;
      if (error instanceof ToolActionRejectedError) {
        setSpanAttributes({
          "app.guardian.decision": error.decision,
          ...(error.riskLevel
            ? { "app.guardian.risk_level": error.riskLevel }
            : undefined),
          ...(error.userAuthorization
            ? {
                "app.guardian.user_authorization": error.userAuthorization,
              }
            : undefined),
        });
      }
      throw error;
    }
    if (review.decision) {
      setSpanAttributes({
        "app.guardian.decision": review.decision.decision,
        "app.guardian.risk_level": review.decision.riskLevel,
        "app.guardian.user_authorization": review.decision.userAuthorization,
      });
    }
    const sandboxInput = buildSandboxInput(toolName, executionInput);
    const isSandbox = Boolean(sandboxTools?.supports(toolName));
    const result = await untilPreempted(
      isSandbox
        ? sandboxTools!.execute({
            toolName,
            input: sandboxInput,
            ...(signal ? { signal } : undefined),
          })
        : Promise.resolve(
            // `prepareCall` checked that the executor exists.
            toolDef.execute!(executionInput, {
              experimental_context: sandbox,
              ...(signal ? { signal } : undefined),
              conversationPrivacy: effectiveConversationPrivacy,
              toolCallId,
            }),
          ),
      signal,
    );

    const toolResult = normalizeToolResult(result, {
      requireStructuredResult: Boolean(toolDef.outputSchema),
      toolName,
    });
    if (isSandbox && pluginAuthOrchestration) {
      await pluginAuthOrchestration.maybeHandleAuthSignal(toolResult.details);
    }
    const nudges = agentHooks
      ? await agentHooks.afterToolExecute({
          input: toolInput,
          name: toolName,
          ...(signal ? { signal } : undefined),
        })
      : [];
    const resultAttributeValue = reportedToolResult(
      result,
      isSandbox,
      toolResult,
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
        ...(hasProjectedPrivateResult
          ? privateTraceResultAttributes()
          : undefined),
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
    return { result: toolResult, nudges };
  };
  const executeDefinition = async (args: {
    toolCallId: string;
    params: Record<string, unknown>;
    signal: AbortSignal | undefined;
    setSpanAttributes: SetSpanAttributes;
    toolDef: AnyToolDefinition;
    toolName: string;
  }) => {
    const prepared = await prepareCall(args);
    const reviews = await reviewToolActions(
      [prepared.action],
      actionReview,
      args.signal,
    );
    const { result, nudges } = await executeReviewed({
      prepared,
      review: reviews.get(args.toolCallId)!,
      signal: args.signal,
      setSpanAttributes: args.setSpanAttributes,
    });
    // Only model calls take this path, so scripts read full results. This is
    // the only place that cuts tool output.
    const capped = await capToolResult(result, {
      toolCallId: args.toolCallId,
      workspace,
    });
    return withToolResultNudges(capped, nudges);
  };
  const reportStatus = async (
    executionToolName: string,
    params: Record<string, unknown>,
  ) => {
    const status =
      executionToolName === "updatePlan"
        ? buildPlanStatus(params)
        : executionToolName === "reportProgress"
          ? buildReportedProgressStatus(params)
          : undefined;
    if (status) {
      await onStatus?.(status);
    }
  };
  /**
   * Run one call under its `gen_ai.execute_tool` span. `body` resolves the
   * target, and updates it when a dispatcher names another tool.
   */
  const traceCall = async (
    call: {
      attributes?: Record<string, unknown>;
      description: string;
      params: unknown;
      signal: AbortSignal | undefined;
      toolCallId: string;
      toolName: string;
    },
    body: (
      setSpanAttributes: SetSpanAttributes,
      target: ToolCallTarget,
    ) => Promise<NormalizedToolResult>,
  ): Promise<TracedToolCall> => {
    const { params, signal, toolCallId, toolName } = call;
    // Intentional OTel deviation: private traces put Junior's safe metadata
    // here, with flattened gen_ai.tool.call.arguments.* extension attributes.
    const toolArgumentsAttribute = serializeToolPayload(params, {
      privateMetadata: true,
    });
    const toolArgumentsMetadata = toGenAiPayloadTraceAttributes(
      "gen_ai.tool.call.arguments",
      params,
    );
    return await withSpan(
      `execute_tool ${toolName}`,
      "gen_ai.execute_tool",
      spanContext,
      async (setSpanAttributes): Promise<TracedToolCall> => {
        const target: ToolCallTarget = {
          toolName,
          params: params as Record<string, unknown>,
        };

        try {
          return {
            kind: "completed",
            result: await body(setSpanAttributes, target),
          };
        } catch (error) {
          if (
            signal?.aborted &&
            !(
              error instanceof AuthorizationPauseError ||
              error instanceof AuthorizationFlowDisabledError ||
              error instanceof ToolActionRejectedError
            )
          ) {
            // The host preempted this attempt, so its outcome is unknown.
            // Report the same fact bash reports for a command timeout
            // instead of a failure the model would retry.
            const preempted = makeStructuredToolOutput({
              aborted: true as const,
              target: target.toolName,
            });
            await notifyToolResult({
              ok: true,
              params: target.params,
              result: preempted.details,
              toolCallId,
              toolName: target.toolName,
            });
            return {
              kind: "preempted",
              result: { ...preempted, isError: false },
            };
          }
          await notifyToolResult({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
            params: target.params,
            toolCallId,
            toolName: target.toolName,
          });
          if (
            error instanceof AuthorizationPauseError ||
            error instanceof AuthorizationFlowDisabledError
          ) {
            throw error;
          }
          if (error instanceof ToolActionRejectedError) {
            return { kind: "rejected", error };
          }
          handleToolExecutionError(
            error,
            target.toolName,
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
        "gen_ai.tool.description": call.description,
        "gen_ai.tool.type": "function",
        ...toolArgumentsMetadata,
        "gen_ai.tool.call.id": toolCallId,
        ...(toolArgumentsAttribute
          ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute }
          : undefined),
        ...call.attributes,
      },
    );
  };

  return {
    /** Run a call that the model made, directly or through `executeTool`. */
    async callFromModel(call: {
      params: unknown;
      signal: AbortSignal | undefined;
      toolCallId: string;
      toolDef: AnyToolDefinition;
      toolName: string;
    }) {
      const { signal, toolCallId, toolDef, toolName } = call;
      const traced = await traceCall(
        {
          description: toolDef.description,
          params: call.params,
          signal,
          toolCallId,
          toolName,
        },
        async (setSpanAttributes, target) => {
          const parsed = target.params;
          if (toolName === EXECUTE_TOOL_NAME) {
            const resolvedCatalogCall = resolveCatalogToolCall(
              parsed,
              options.catalogTools,
            );
            target.toolName = resolvedCatalogCall.toolName;
            target.params = resolvedCatalogCall.arguments;
            setSpanAttributes({
              "gen_ai.tool.dispatcher.name": EXECUTE_TOOL_NAME,
              "gen_ai.tool.description":
                resolvedCatalogCall.definition.description,
              "gen_ai.tool.name": resolvedCatalogCall.toolName,
            });
            const catalogCall = prepareCatalogToolCall(resolvedCatalogCall);
            target.params = catalogCall.arguments;
            await reportStatus(target.toolName, target.params);
            return await executeDefinition({
              toolCallId,
              params: catalogCall.arguments,
              signal,
              setSpanAttributes,
              toolDef: catalogCall.definition,
              toolName: catalogCall.toolName,
            });
          }

          await reportStatus(target.toolName, target.params);
          return await executeDefinition({
            toolCallId,
            params: parsed,
            signal,
            setSpanAttributes,
            toolDef,
            toolName,
          });
        },
      );
      if (traced.kind === "rejected") {
        throw traced.error;
      }
      return traced.result;
    },

    /**
     * Run a call that a person approved on its Tool approval. The approval
     * replaces action review, so the call runs only when its hook-adjusted
     * input is still the stored input. Other failures throw.
     */
    async callApproved(call: {
      input: Record<string, unknown>;
      signal: AbortSignal | undefined;
      tool: AnyToolDefinition;
      toolCallId: string;
      toolName: string;
    }): Promise<NormalizedToolResult> {
      const { input, signal, tool, toolCallId, toolName } = call;
      const traced = await traceCall(
        {
          description: tool.description,
          params: input,
          signal,
          toolCallId,
          toolName,
        },
        async (setSpanAttributes) => {
          const prepared = await prepareCall({
            toolCallId,
            params: input,
            toolDef: tool,
            toolName,
          });
          if (!isDeepStrictEqual(prepared.action.input, input)) {
            throw new Error(
              `A plugin hook changed the approved input of ${toolName}.`,
            );
          }
          const { result } = await executeReviewed({
            prepared,
            review: { allowed: true },
            signal,
            setSpanAttributes,
          });
          return result;
        },
      );
      if (traced.kind === "rejected") {
        throw traced.error;
      }
      return traced.result;
    },

    /**
     * Review the calls of one script VM drain as one batch. The gate owns
     * the batch limit.
     */
    async reviewScriptCalls(
      actions: readonly ToolAction[],
      signal: AbortSignal | undefined,
    ) {
      return await reviewToolActions(actions, actionReview, signal);
    },

    /**
     * Run a call that a Code Mode script made. It takes the same path as a
     * direct call, and `call.review` supplies the batch review result.
     */
    async callFromScript(call: ScriptToolCall): Promise<ScriptToolCallOutcome> {
      const { signal, tool, toolCallId, toolName } = call;
      // The script gets the tool's own value. Nudges go to the codemode
      // result, so they never change what the script reads.
      let nudges: ToolResultNudge[] = [];
      let traced: TracedToolCall;
      try {
        traced = await traceCall(
          {
            attributes: { "gen_ai.tool.dispatcher.name": CODEMODE_TOOL_NAME },
            description: tool.description,
            params: call.input,
            signal,
            toolCallId,
            toolName,
          },
          async (setSpanAttributes) => {
            const input = call.input ?? {};
            if (typeof input !== "object" || Array.isArray(input)) {
              throw new ToolInputError(
                `${CODEMODE_TOOL_NAME} arguments for ${toolName} must be an object.`,
              );
            }
            const { arguments: params } = prepareCatalogToolCall(
              {
                arguments: input as Record<string, unknown>,
                definition: tool,
                toolName,
              },
              CODEMODE_TOOL_NAME,
            );
            await reportStatus(toolName, params);
            const prepared = await prepareCall({
              toolCallId,
              params,
              toolDef: tool,
              toolName,
            });
            const reviewed = await executeReviewed({
              prepared,
              review: await call.review(prepared.action),
              signal,
              setSpanAttributes,
            });
            nudges = reviewed.nudges;
            return reviewed.result;
          },
        );
      } catch (error) {
        if (
          error instanceof AuthorizationPauseError ||
          error instanceof AuthorizationFlowDisabledError
        ) {
          throw error;
        }
        return {
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
      if (traced.kind === "completed") {
        return { status: "ok", result: traced.result, nudges };
      }
      if (traced.kind === "preempted") {
        return { status: "preempted" };
      }
      // Take the gate's marker now, so the script result can carry it.
      const projected = actionReview?.projectToolResult(toolCallId, {
        details: {},
        isError: true,
      });
      return {
        status: "rejected",
        error: traced.error,
        marker: getToolActionRejectionMarker(projected),
      };
    },
  };
}

/** A pipeline for one Run's tools. */
export type ToolPipeline = ReturnType<typeof createToolPipeline>;

/** Run context and callbacks for the tools that `createPiAgentTools` wraps. */
export interface PiAgentToolsOptions {
  spanContext: LogContext;
  /**
   * Who pays for the tool search rerank call. Callers without a Conversation
   * pass `{ owner: "none" }`.
   */
  searchToolsCost: ConversationModelCost;
  onStatus?: (status: AssistantStatusSpec) => void | Promise<void>;
  sandboxTools?: SandboxTools;
  pluginAuthOrchestration?: PluginAuthOrchestration;
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    params: Record<string, unknown>,
  ) => void | Promise<void>;
  agentHooks?: PluginHookRunner;
  conversationPrivacy?: ConversationPrivacy;
  onToolResult?: (report: ToolExecutionReport) => void | Promise<void>;
  actionReview?: ToolActionReview;
  codeMode?: Pick<CodeModeToolOptions, "countToolCall"> & {
    /** Keeps the full text of a model-facing result that was cut. */
    workspace?: Pick<SandboxWorkspace, "writeFiles">;
  };
}

/**
 * Wrap tool definitions into Pi Agent tool objects with logging, validation,
 * and sandbox execution. With `codeMode`, the model also gets the `codemode`
 * tool, which runs scripts over this pipeline.
 */
export function createPiAgentTools(
  tools: Record<string, AnyToolDefinition>,
  sandbox: SkillSandbox,
  {
    spanContext,
    searchToolsCost,
    onStatus,
    sandboxTools,
    pluginAuthOrchestration,
    onToolCall,
    agentHooks,
    conversationPrivacy,
    onToolResult,
    actionReview,
    codeMode,
  }: PiAgentToolsOptions,
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
  if (visibleTools[CODEMODE_TOOL_NAME]) {
    throw new Error(`${CODEMODE_TOOL_NAME} is reserved for Code Mode`);
  }
  visibleTools[SEARCH_TOOLS_NAME] = createSearchToolsTool(
    plannedTools.catalogTools,
    searchToolsCost,
  );
  visibleTools[EXECUTE_TOOL_NAME] = createExecuteToolTool();
  const pipeline = createToolPipeline({
    catalogTools: plannedTools.catalogTools,
    sandbox,
    spanContext,
    onStatus,
    sandboxTools,
    pluginAuthOrchestration,
    onToolCall,
    agentHooks,
    conversationPrivacy,
    onToolResult,
    actionReview,
    workspace: codeMode?.workspace,
  });
  if (codeMode) {
    const modelOnlyTools = [
      ...Object.keys(visibleTools).filter(
        (name) => !Object.hasOwn(plannedTools.scriptTools, name),
      ),
      CODEMODE_TOOL_NAME,
    ];
    visibleTools[CODEMODE_TOOL_NAME] = createCodeModeTool({
      countToolCall: codeMode.countToolCall,
      modelOnlyTools,
      pipeline,
      scriptTools: plannedTools.scriptTools,
    });
  }
  return Object.entries(visibleTools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema as AgentTool["parameters"],
    prepareArguments: toolDef.prepareArguments,
    // A direct call is reviewed alone, so a tool that may need review runs
    // one at a time. Code Mode reviews a drain as one batch instead.
    executionMode:
      toolDef.permission !== undefined && toolDef.permission !== "allow"
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
      return await pipeline.callFromModel({
        params,
        signal,
        toolCallId,
        toolDef,
        toolName,
      });
    },
  }));
}
