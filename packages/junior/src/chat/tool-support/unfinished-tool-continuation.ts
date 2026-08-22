import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { isRecord } from "@/chat/coerce";
import { piMessageSchema, type PiMessage } from "@/chat/pi/messages";
import {
  isContinuablePiBoundary,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import {
  injectContinuationToolName,
  juniorToolBoundContinuationSchema,
  juniorToolContinuationSchema,
} from "@/chat/tool-support/structured-result";

export interface UnfinishedToolContinuation {
  toolName: string;
  arguments: Record<string, unknown>;
  reason?: string;
}

/** Parse host-continue metadata from structured tool details. */
export function unfinishedToolContinuationFromDetails(
  details: unknown,
  fallbackToolName?: string,
): UnfinishedToolContinuation | null {
  if (!isRecord(details) || details.unfinished !== true) {
    return null;
  }
  if (!isRecord(details.continuation)) {
    return null;
  }

  const continuation = details.continuation;
  const toolName =
    typeof continuation.tool_name === "string" &&
    continuation.tool_name.length > 0
      ? continuation.tool_name
      : fallbackToolName;
  if (!toolName) {
    return null;
  }

  // Unbound schema is strict and rejects runtime-injected tool_name.
  const { tool_name: _ignored, ...unboundContinuation } = continuation;
  const parsed = juniorToolContinuationSchema.safeParse(unboundContinuation);
  if (!parsed.success) {
    return null;
  }

  const bound = juniorToolBoundContinuationSchema.safeParse({
    ...parsed.data,
    tool_name: toolName,
  });
  if (!bound.success) {
    return null;
  }

  return {
    toolName: bound.data.tool_name,
    arguments: bound.data.arguments,
    ...(bound.data.reason ? { reason: bound.data.reason } : {}),
  };
}

/**
 * Find a host-continue tool result in the trailing tool-result tail.
 * A later non-continue result for the same tool name blocks older waits.
 */
export function pendingUnfinishedToolContinuation(
  messages: readonly PiMessage[],
): UnfinishedToolContinuation | null {
  const terminalToolNames = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolResultMessage(message)) break;
    const toolName = normalizeToolNameFromResult(message);
    const pending = unfinishedToolContinuationFromDetails(
      message.details,
      toolName,
    );
    if (pending) {
      if (terminalToolNames.has(pending.toolName)) continue;
      return pending;
    }
    if (toolName) {
      terminalToolNames.add(toolName);
    }
  }
  return null;
}

/**
 * Re-enter an unfinished tool from its continuation payload without a model turn.
 * Appends a complete assistant toolCall + toolResult boundary.
 */
export async function continueUnfinishedTool(args: {
  messages: PiMessage[];
  tools: AgentTool[];
  signal?: AbortSignal;
}): Promise<
  | { kind: "none" }
  | { kind: "waiting"; messages: PiMessage[] }
  | { kind: "ready"; messages: PiMessage[] }
  | { kind: "failed"; error: unknown; messages: PiMessage[] }
> {
  if (!isContinuablePiBoundary(args.messages)) return { kind: "none" };
  const pending = pendingUnfinishedToolContinuation(args.messages);
  if (!pending) return { kind: "none" };

  const tool = args.tools.find((entry) => entry.name === pending.toolName);
  if (!tool) return { kind: "none" };

  const toolCallId = randomUUID();
  const assistantMessage = piMessageSchema.parse({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "host-continue",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: pending.toolName,
        arguments: pending.arguments,
      },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
    stopReason: "toolUse",
  });

  let result: AgentToolResult<unknown>;
  try {
    result = await tool.execute(toolCallId, pending.arguments, args.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const toolResultMessage = piMessageSchema.parse({
      role: "toolResult",
      toolCallId,
      toolName: pending.toolName,
      content: [{ type: "text", text: message }],
      details: { error: message },
      isError: true,
      timestamp: Date.now(),
    });
    return {
      kind: "failed",
      error,
      messages: [...args.messages, assistantMessage, toolResultMessage],
    };
  }

  const details = injectContinuationToolName(result.details, pending.toolName);
  const toolResultMessage = piMessageSchema.parse({
    role: "toolResult",
    toolCallId,
    toolName: pending.toolName,
    content: result.content,
    details,
    isError: false,
    timestamp: Date.now(),
  });
  const messages = [...args.messages, assistantMessage, toolResultMessage];

  return unfinishedToolContinuationFromDetails(details, pending.toolName)
    ? { kind: "waiting", messages }
    : { kind: "ready", messages };
}
