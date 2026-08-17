import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isContinuablePiBoundary,
  isToolResultMessage,
} from "@/chat/pi/transcript";
import {
  isWorkspaceSnapshotWaitingResult,
  workspaceNameFromWaitingResult,
} from "@/chat/sandbox/snapshot/waiting-error";

const SWITCH_WORKSPACE_TOOL = "switchWorkspace";

/** Pending soft wait for a Workspace snapshot from the latest tool result. */
export function pendingWorkspaceSnapshotWait(
  messages: readonly PiMessage[],
): { name: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isToolResultMessage(message)) break;
    if (message.toolName !== SWITCH_WORKSPACE_TOOL) continue;
    const name = workspaceNameFromWaitingResult(message.details);
    return name ? { name } : null;
  }
  return null;
}

/**
 * Continue a soft Workspace snapshot wait without another model turn.
 * Re-invokes switchWorkspace and appends the complete Pi tool boundary.
 */
export async function continueWorkspaceSnapshotWait(args: {
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
  const pending = pendingWorkspaceSnapshotWait(args.messages);
  if (!pending) return { kind: "none" };

  const tool = args.tools.find((entry) => entry.name === SWITCH_WORKSPACE_TOOL);
  if (!tool) return { kind: "none" };

  const toolCallId = randomUUID();
  const assistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "host-continue",
    content: [
      {
        type: "toolCall",
        id: toolCallId,
        name: SWITCH_WORKSPACE_TOOL,
        arguments: { name: pending.name },
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
  } as PiMessage;

  let result: AgentToolResult<unknown>;
  try {
    result = await tool.execute(
      toolCallId,
      { name: pending.name },
      args.signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const toolResultMessage = {
      role: "toolResult",
      toolCallId,
      toolName: SWITCH_WORKSPACE_TOOL,
      content: [{ type: "text", text: message }],
      details: { error: message },
      isError: true,
      timestamp: Date.now(),
    } as PiMessage;
    return {
      kind: "failed",
      error,
      messages: [...args.messages, assistantMessage, toolResultMessage],
    };
  }

  const toolResultMessage = {
    role: "toolResult",
    toolCallId,
    toolName: SWITCH_WORKSPACE_TOOL,
    content: result.content,
    details: result.details,
    isError: false,
    timestamp: Date.now(),
  } as PiMessage;
  const messages = [
    ...args.messages,
    assistantMessage,
    toolResultMessage,
  ] as PiMessage[];

  return isWorkspaceSnapshotWaitingResult(result.details)
    ? { kind: "waiting", messages }
    : { kind: "ready", messages };
}
