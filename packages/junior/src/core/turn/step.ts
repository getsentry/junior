// One step of a Turn: one model request, or one batch of tool calls. A step
// keeps no state of its own. It reads the history, does one thing, and returns
// the messages to append. The caller owns the lease, the commit, and the next
// step, so a step that runs again after a crash sees the same history.
import {
  toToolDeclaration,
  validateToolArguments,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelSettings } from "@/core/model/client";
import type { ModelFailure } from "@/core/model/failure";
import { withSpan } from "@/core/telemetry";
import type { ToolDefinition, ToolResult } from "@/core/tool";
import type { ToolExecutionEnvironment } from "@/core/tool-execution-environment/types";

/**
 * The model request of a step: the system prompt, the messages with the new
 * ones at the end, the model settings, and the new messages in the caller's
 * own form, which the step returns with its result.
 */
export type StepRequest<T> = {
  systemPrompt: string;
  messages: Message[];
  model: ModelSettings;
  newMessages: T[];
};

export type StepInput<T> = {
  /** The Conversation history, without the new messages. */
  history: Message[];
  /**
   * Builds the model request. The step calls it only for a model request: a
   * tool batch must follow its tool calls directly, so it adds no messages.
   */
  request: () => Promise<StepRequest<T>>;
  tools: ToolDefinition[];
  client: ModelClient;
  /** The Conversation id, which keeps its model requests in one session. */
  session: string;
  /**
   * True when an earlier attempt at this step did not commit, so its tool
   * calls may have run.
   */
  replay: boolean;
  /**
   * True when the pending tool calls belong to an earlier Turn that ended
   * before their results. The step runs none of them and closes each with an
   * error result, so the next step is a model request.
   */
  skipDanglingToolCalls: boolean;
  signal: AbortSignal;
  environment?: ToolExecutionEnvironment;
};

/**
 * What the step adds to the history, and what the Turn does next. `continue`:
 * run another step. `completed` ends the Turn. `failed`: the model request
 * failed and the step adds nothing. `reply` is the failed reply, so the caller
 * can retry the step or end the Turn.
 */
export type StepResult =
  | {
      outcome: "continue" | "completed";
      messages: Array<AssistantMessage | ToolResultMessage>;
    }
  | { outcome: "failed"; reply: AssistantMessage; failure: ModelFailure };

/**
 * Runs one step of a Turn: the pending tool calls if there are any, else one
 * model request. Only a model request calls `request`, and the step returns
 * its new messages. A tool batch returns none.
 */
export async function runStep<T>(
  input: StepInput<T>,
): Promise<{ result: StepResult; newMessages: T[] }> {
  const pending = collectPendingToolCalls(input.history);
  if (pending.calls.length > 0) {
    return { result: await runToolCalls(pending, input), newMessages: [] };
  }
  const request = await input.request();
  if (request.messages.at(-1)?.role === "assistant") {
    throw new Error("The history ends with a reply, so the Turn has no step");
  }
  return {
    result: await requestModel(request, input),
    newMessages: request.newMessages,
  };
}

async function requestModel(
  { systemPrompt, messages, model }: StepRequest<unknown>,
  {
    client,
    session,
    tools,
    signal,
  }: Pick<StepInput<unknown>, "client" | "session" | "tools" | "signal">,
): Promise<StepResult> {
  const { message: reply, failure } = await client.complete(
    {
      model,
      session,
      context: {
        systemPrompt,
        messages,
        tools: tools.map(toToolDeclaration),
      },
    },
    signal,
  );
  if (signal.aborted) {
    throw signal.reason;
  }
  if (failure) {
    return { outcome: "failed", reply, failure };
  }
  if (reply.content.some((block) => block.type === "toolCall")) {
    return { outcome: "continue", messages: [reply] };
  }
  if (reply.stopReason === "stop" || reply.stopReason === "length") {
    return { outcome: "completed", messages: [reply] };
  }
  return {
    outcome: "failed",
    reply,
    failure: {
      kind: "invalid_response",
      retryable: false,
      message: `Unsupported stop reason: ${reply.stopReason}`,
    },
  };
}

type PendingToolCalls = {
  calls: ToolCall[];
  /**
   * The reply hit the output token limit, so any call in it may have cut-off
   * arguments that still parse.
   */
  truncated: boolean;
};

/**
 * The tool calls of the last reply that have no result yet. Only tool results
 * may follow the reply. Any other message means the reply has no open calls.
 */
function collectPendingToolCalls(messages: Message[]): PendingToolCalls {
  const answered = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      answered.add(message.toolCallId);
      continue;
    }
    if (message?.role !== "assistant") {
      return { calls: [], truncated: false };
    }
    return {
      calls: message.content.filter(
        (block): block is ToolCall =>
          block.type === "toolCall" && !answered.has(block.id),
      ),
      truncated: message.stopReason === "length",
    };
  }
  return { calls: [], truncated: false };
}

async function runToolCalls(
  pending: PendingToolCalls,
  input: StepInput<unknown>,
): Promise<StepResult> {
  const results = await Promise.all(
    // oxlint-disable-next-line junior/bounded-fan-out -- The calls of one model message run together, as Pi runs a tool batch.
    pending.calls.map((call) => runToolCall(call, pending.truncated, input)),
  );
  // An aborted tool returns an error result. Those results must not reach the
  // history, so the step throws as it does for an aborted model request.
  if (input.signal.aborted) {
    throw input.signal.reason;
  }
  return {
    outcome: results.every(({ result }) => result.endsTurn === true)
      ? "completed"
      : "continue",
    messages: results.map(({ result, call }) => toResultMessage(call, result)),
  };
}

type ToolCallStatus =
  | "completed"
  | "failed"
  | "aborted"
  | "not_found"
  | "invalid_arguments"
  | "replay_skipped"
  | "truncated"
  | "dangling_skipped";

type ToolCallRun = { status: ToolCallStatus; result: ToolResult };

type ToolCallOutcome = { call: ToolCall; result: ToolResult };

function runToolCall(
  call: ToolCall,
  truncated: boolean,
  input: StepInput<unknown>,
): Promise<ToolCallOutcome> {
  return withSpan(
    "gen_ai.execute_tool",
    {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": call.name,
      "gen_ai.tool.call.id": call.id,
      "gen_ai.tool.type": "function",
    },
    async (span) => {
      const { status, result } = await executeToolCall(call, truncated, input);
      span.setAttribute("app.tool_call.outcome", status);
      return { call, result };
    },
  );
}

async function executeToolCall(
  call: ToolCall,
  truncated: boolean,
  input: StepInput<unknown>,
): Promise<ToolCallRun> {
  if (input.skipDanglingToolCalls) {
    return danglingRun(call, input);
  }
  if (truncated) {
    return errorRun(
      "truncated",
      `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    );
  }
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return errorRun("not_found", `Tool ${call.name} not found`);
  }
  if (input.replay && tool.replay === "never") {
    return errorRun(
      "replay_skipped",
      "This call was interrupted before its result was saved, so it may have run. Check its effect before you call it again.",
    );
  }
  let args: unknown;
  try {
    args = validateToolArguments(tool, call);
  } catch (error) {
    return errorRun("invalid_arguments", errorText(error));
  }
  if (!isJsonObject(args)) {
    return errorRun(
      "invalid_arguments",
      "Tool arguments must be a JSON object",
    );
  }
  // A throw from the tool is a result the model can react to.
  try {
    const result = await tool.execute(args, {
      callId: call.id,
      signal: input.signal,
      environment: input.environment,
    });
    return { status: result.isError ? "failed" : "completed", result };
  } catch (error) {
    return errorRun(
      input.signal.aborted ? "aborted" : "failed",
      errorText(error),
    );
  }
}

function danglingRun(call: ToolCall, input: StepInput<unknown>): ToolCallRun {
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  return errorRun(
    "dangling_skipped",
    tool?.replay === "safe"
      ? "The previous Turn ended before this call returned, so there is no result. Call it again if you still need it."
      : "The previous Turn ended before this call's result was saved. It may or may not have run. Check its effect before you call it again.",
  );
}

// `validateToolArguments` returns `any`.
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorRun(status: ToolCallStatus, text: string): ToolCallRun {
  return {
    status,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function toResultMessage(
  call: ToolCall,
  result: ToolResult,
): ToolResultMessage {
  const message: ToolResultMessage = {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError: result.isError === true,
    timestamp: Date.now(),
  };
  if (result.details !== undefined) {
    message.details = result.details;
  }
  return message;
}
