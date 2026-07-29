import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { Reply } from "@/chat/agent/request";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { PiMessage } from "@/chat/pi/messages";
import { isAssistantMessage } from "@/chat/pi/transcript";

function assistantMessage(text: string): Reply["message"] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "fake-agent",
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Default harness runner: resolve @/chat/agent-run at call time so a test's
 * vi.mock of that module is honored regardless of import order, while tests
 * without the mock exercise the real executor.
 */
export const realAgentRunner: AgentRunner = {
  run: async (request) => {
    const { executeAgentRun } = await import("@/chat/agent");
    return await executeAgentRun(request);
  },
};

/**
 * Flatten a grouped run request for concise assertions at fake-runner boundaries.
 */
export function flattenAgentRunRequestForTest(
  request: Parameters<AgentRunner["run"]>[0],
) {
  return {
    conversationId: request.conversationId,
    turnId: request.turnId,
    ...(request.runId ? { runId: request.runId } : {}),
    ...request.input,
    ...request.routing,
    ...(request.policy ?? {}),
    ...(request.state ?? {}),
    ...(request.observers ?? {}),
    ...(request.delivery ? { delivery: request.delivery } : {}),
    ...(request.durability ?? {}),
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
  request: Parameters<AgentRunner["run"]>[0],
  replies: Array<Pick<Reply, "text">>,
  finalHistory?: PiMessage[],
): Promise<PiMessage[]> {
  if (!request.delivery) {
    throw new Error("scripted runner requires assistant delivery");
  }
  const history = finalHistory
    ? finalHistory.slice(0, -replies.length)
    : [...(request.input.piMessages ?? [])];
  const firstReplyIndex = (finalHistory?.length ?? 0) - replies.length;
  for (const [index, reply] of replies.entries()) {
    const message =
      finalHistory?.[firstReplyIndex + index] ?? assistantMessage(reply.text);
    if (!isAssistantMessage(message)) {
      throw new Error("scripted reply requires an assistant message");
    }
    history.push(message);
    await request.delivery({ message, text: reply.text });
  }
  return history;
}

/** Script completed assistant messages through the production delivery port. */
export function scriptedAssistantMessageRunner(args: {
  messages: Array<Pick<Reply, "text">>;
  result: AgentRunResult;
}): AgentRunner {
  return {
    run: async (request) => {
      await deliverAssistantMessagesForTest(
        request,
        args.messages,
        args.result.piMessages,
      );
      return completedAgentRun(args.result);
    },
  };
}
