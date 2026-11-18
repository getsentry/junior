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
import type { ToolDefinition, ToolResult } from "@/core/tool";
import type { ToolExecutionEnvironment } from "@/core/tool-execution-environment/types";

/** Makes one model request. A failed request returns a message with `stopReason: "error"`. */
export type CompleteModel = (
  context: Context,
  signal: AbortSignal,
) => Promise<AssistantMessage>;

export type StepInput = {
  systemPrompt: string;
  /**
   * The Conversation history, with the new inputs at the end. Add inputs only
   * before a model request: a tool batch must follow its tool calls directly.
   */
  messages: Message[];
  tools: ToolDefinition[];
  complete: CompleteModel;
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
 * run another step. `completed` and `failed` end the Turn. A failed step adds
 * nothing.
 */
export type StepResult =
  | { outcome: "continue" | "completed"; messages: Message[] }
  | { outcome: "failed"; error: string };

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
    pending.calls.map((call) => runToolCall(call, pending.truncated, input)),
  );
  return {
    outcome: results.every(({ result }) => result.endsTurn === true)
      ? "completed"
      : "continue",
    messages: results.map(({ result, call }) => toResultMessage(call, result)),
  };
}

type ToolCallOutcome = { call: ToolCall; result: ToolResult };

async function runToolCall(
  call: ToolCall,
  truncated: boolean,
  input: StepInput,
): Promise<ToolCallOutcome> {
  // Same rule and text as pi-agent-core.
  if (truncated) {
    return errorOutcome(
      call,
      `Tool call "${call.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
    );
  }
  const tool = input.tools.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return errorOutcome(call, `Tool ${call.name} not found`);
  }
  if (input.replay && tool.replay === "unsafe") {
    return errorOutcome(
      call,
      "This call was interrupted before its result was saved, so it may have run. Check its effect before you call it again.",
    );
  }
  // A validation error and a throw from the tool are both results the model
  // can react to.
  try {
    const args: unknown = validateToolArguments(tool, call);
    if (!isJsonObject(args)) {
      return errorOutcome(call, "Tool arguments must be a JSON object");
    }
    const result = await tool.execute(args, {
      callId: call.id,
      signal: input.signal,
      environment: input.environment,
    });
    return { call, result };
  } catch (error) {
    return errorOutcome(
      call,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// `validateToolArguments` returns `any`.
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorOutcome(call: ToolCall, text: string): ToolCallOutcome {
  return {
    call,
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
