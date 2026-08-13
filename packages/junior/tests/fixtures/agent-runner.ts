import {
  createAgentRunner,
  type AgentRunner,
} from "@/chat/runtime/agent-runner";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
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

/** Run the real agent while replacing only model output. */
export function createModelAgentRunner(streamFn: StreamFn): AgentRunner {
  return createModelAgentRunnerForRun(() => streamFn);
}

/** Run the real agent while choosing a fixed model stream for each run. */
export function createModelAgentRunnerForRun(
  streamForRun: (run: AgentRun) => StreamFn,
): AgentRunner {
  return createAgentRunner(async (run) => {
    const { executeAgentRun } = await import("@/chat/agent");
    return await executeAgentRun(run, streamForRun(run));
  });
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
