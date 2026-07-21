import type { AgentRunner } from "@/chat/runtime/agent-runner";
import type { AgentAssistantMessage } from "@/chat/agent/request";
import type { AgentRunResult } from "@/chat/services/turn-result";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

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
    ...(request.delivery ?? {}),
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
  messages: AgentAssistantMessage[],
): Promise<void> {
  if (!request.delivery) {
    throw new Error("scripted runner requires assistant delivery");
  }
  for (const message of messages) {
    await request.delivery.onAssistantMessage(message);
  }
}

/** Script completed assistant messages through the production delivery port. */
export function scriptedAssistantMessageRunner(args: {
  messages: AgentAssistantMessage[];
  result: AgentRunResult;
}): AgentRunner {
  return {
    run: async (request) => {
      await deliverAssistantMessagesForTest(request, args.messages);
      return completedAgentRun(args.result);
    },
  };
}
