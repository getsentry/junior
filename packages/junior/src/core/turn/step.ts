// One step of a Turn: one model request, or one batch of tool calls. A step
// keeps no state of its own. It reads the history, does one thing, and returns
// the messages to append. The caller owns the lease, the commit, and the next
// step, so a step that runs again after a crash sees the same history.
import {
  toToolDeclaration,
  validateToolArguments,
  type AssistantMessage,
  type Context,
  type JsonObject,
  type Message,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { withSpan } from "@/core/telemetry";
import type { ToolDefinition, ToolResult } from "@/core/tool";
import type { ToolExecutionEnvironment } from "@/core/tool-execution-environment/types";

export type StepInput = {
  systemPrompt: string;
  /**
   * The Conversation history, with the new inputs at the end. Add inputs only
   * before a model request: a tool batch must follow its tool calls directly.
   */
  messages: Message[];
  tools: ToolDefinition[];
  /** Makes one model request. A failed request returns a message with `stopReason: "error"`. */
  complete: (
    context: Context,
    signal: AbortSignal,
  ) => Promise<AssistantMessage>;
  /**
   * True when an earlier attempt at this step did not commit, so its tool
   * calls may have run.
   */
  replay: boolean;
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
  | { outcome: "failed"; error: string; reply: AssistantMessage };

/** Runs one step of a Turn: the pending tool calls if there are any, else one model request. */
export async function runStep(input: StepInput): Promise<StepResult> {
  const pending = collectPendingToolCalls(input.messages);
  if (pending.calls.length > 0) {
    return runToolCalls(pending, input);
  }
  if (input.messages.at(-1)?.role === "assistant") {
    throw new Error("The history ends with a reply, so the Turn has no step");
  }
  return requestModel(input);
}

async function requestModel(input: StepInput): Promise<StepResult> {
  const reply = await input.complete(
    {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools.map(toToolDeclaration),
    },
    input.signal,
  );
  if (input.signal.aborted) {
    throw input.signal.reason;
  }
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    return {
      outcome: "failed",
      error:
        reply.errorMessage ?? `Model request ended with ${reply.stopReason}`,
      reply,
    };
  }
  if (reply.content.some((block) => block.type === "toolCall")) {
    return { outcome: "continue", messages: [reply] };
  }
  if (reply.stopReason === "stop" || reply.stopReason === "length") {
    return { outcome: "completed", messages: [reply] };
  }
  return {
    outcome: "failed",
    error: `Unsupported stop reason: ${reply.stopReason}`,
    reply,
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
  input: StepInput,
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
  | "truncated";

type ToolCallRun = { status: ToolCallStatus; result: ToolResult };

type ToolCallOutcome = { call: ToolCall; result: ToolResult };

function runToolCall(
  call: ToolCall,
  truncated: boolean,
  input: StepInput,
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
  input: StepInput,
): Promise<ToolCallRun> {
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
