import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";
import type { AgentRun } from "@/chat/agent/types";

function assistantMessage(text: string): AssistantMessage {
  return fauxAssistantMessage(text);
}

/**
 * Default harness runner: resolve @/chat/agent at call time so a test's
 * vi.mock of that module is honored regardless of import order, while tests
 * without the mock exercise the real executor.
 */
export const realAgentRunner: AgentRunner = {
  run: async (run) => {
    const { executeAgentRun } = await import("@/chat/agent");
    return await executeAgentRun(run);
  },
};

/**
 * Compatibility view of a flat `AgentRun` for older integration tests.
 * Prefer reading `run.instruction` / `run.history` / `run.durability` directly
 * in new tests.
 */
export function flattenAgentRunForTest(run: AgentRun) {
  return {
    ...run,
    messageText: run.instruction.text,
    userAttachments: run.instruction.attachments,
    inboundAttachmentCount: run.instruction.inboundAttachmentCount,
    omittedImageAttachmentCount: run.instruction.omittedImageAttachmentCount,
    conversationContext: run.instruction.context,
    includeConversationContextWithPiMessages:
      run.instruction.includeConversationContextWithHistory,
    piMessages: run.history ? [...run.history] : undefined,
    turnDeadlineAtMs: run.deadlineAtMs,
    reasoningLevel: run.reasoning,
    locationConfiguration: run.environment?.locationConfiguration,
    configuration: run.environment?.configuration,
    skillDirs: run.environment?.skillDirs,
    toolOverrides: run.environment?.toolOverrides,
    sandboxTracePropagation: run.environment?.sandboxTracePropagation,
    sandboxEgressSignals: run.environment?.sandboxEgressSignals,
    pendingAuth: run.state?.pendingAuth,
    sandboxRef: run.state?.sandboxRef,
    onInputCommitted: run.durability?.onInputCommitted,
    shouldYield: run.durability?.shouldYield,
    drainSteeringMessages: run.durability?.drainSteeringMessages,
    recordPendingAuth: run.durability?.recordPendingAuth,
    onSandboxRefChanged: run.durability?.onSandboxRefChanged,
    spawnAgent: run.durability?.spawnAgent,
    // Legacy observer names used by older integration tests.
    onStatus: run.onEvent
      ? async (status: { text: string }) => {
          await run.onEvent?.({ type: "status", text: status.text });
        }
      : undefined,
    onToolInvocation: run.onEvent
      ? async (invocation: {
          params: Record<string, unknown>;
          toolCallId?: string;
          toolName: string;
        }) => {
          await run.onEvent?.({
            type: "tool_started",
            toolCallId: invocation.toolCallId ?? "tool-call",
            toolName: invocation.toolName,
            params: invocation.params,
          });
        }
      : undefined,
    onToolResult: run.onEvent
      ? async (report: import("@/chat/tool-support/tool-execution-report").ToolExecutionReport) => {
          await run.onEvent?.({ type: "tool_finished", report });
        }
      : undefined,
  };
}

/**
 * Guard runner for paths that must never reach agent execution; failing loud
 * beats silently producing a reply the test did not script.
 */
export function neverRunAgentRunner(): AgentRunner {
  return {
    run: async () => {
      throw new Error("agent runner should not run in this test");
    },
  };
}

/** Deliver explicitly scripted assistant messages from an inline fake runner. */
export async function deliverAssistantMessagesForTest(
  run: AgentRun,
  replies: Array<{ text: string }>,
  finalHistory?: PiMessage[],
): Promise<PiMessage[]> {
  if (!run.delivery) {
    throw new Error("scripted runner requires assistant delivery");
  }
  const history = finalHistory
    ? finalHistory.slice(0, -replies.length)
    : [...(run.history ?? [])];
  const firstReplyIndex = (finalHistory?.length ?? 0) - replies.length;
  for (const [index, reply] of replies.entries()) {
    const message =
      finalHistory?.[firstReplyIndex + index] ?? assistantMessage(reply.text);
    if (!isAssistantMessage(message)) {
      throw new Error("scripted reply requires an assistant message");
    }
    const visibleText = getAssistantReplyText(message);
    if (visibleText !== reply.text.trim()) {
      throw new Error(
        `scripted reply text ${JSON.stringify(reply.text)} does not match ` +
          `its assistant message text ${JSON.stringify(visibleText)}`,
      );
    }
    history.push(message);
    await run.delivery(message);
  }
  return history;
}

/** Script completed assistant messages through the production delivery port. */
export function scriptedAssistantMessageRunner(args: {
  messages: Array<{ text: string }>;
  result: AgentRunResult;
}): AgentRunner {
  return {
    run: async (run) => {
      await deliverAssistantMessagesForTest(
        run,
        args.messages,
        args.result.piMessages,
      );
      return completedAgentRun(args.result);
    },
  };
}
