import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PiMessage } from "@/chat/pi/messages";
import {
  isToolResultMessage,
  isContinuablePiBoundary,
} from "@/chat/pi/transcript";
import {
  isWorkspaceSnapshotWaitingResult,
  workspaceNameFromWaitingResult,
} from "@/chat/sandbox/snapshot/waiting-error";

const SWITCH_WORKSPACE_TOOL = "switchWorkspace";

/** Pending soft-wait for a Workspace snapshot from the latest tool result. */
export function pendingWorkspaceSnapshotWait(
  messages: readonly PiMessage[],
): { name: string } | null {
  const last = messages.at(-1);
  if (!isToolResultMessage(last) || last.toolName !== SWITCH_WORKSPACE_TOOL) {
    return null;
  }
  const name = workspaceNameFromWaitingResult(last.details);
  if (!name) return null;
  return { name };
}

/**
 * Host-owned continuation of a soft Workspace snapshot wait.
 * Re-invokes switchWorkspace without a model turn and appends the tool call.
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
  if (!isContinuablePiBoundary(args.messages)) {
    return { kind: "none" };
  }
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
    return {
      kind: "failed",
      error,
      messages: [...args.messages, assistantMessage],
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

  if (isWorkspaceSnapshotWaitingResult(result.details)) {
    return { kind: "waiting", messages };
  }
  return { kind: "ready", messages };
}
