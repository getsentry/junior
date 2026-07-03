import type { AgentRunner } from "@/chat/runtime/agent-runner";

/**
 * Default harness runner: resolve @/chat/respond at call time so a test's
 * vi.mock of that module is honored regardless of import order, while tests
 * without the mock exercise the real reply generator.
 */
export const respondAgentRunner: AgentRunner = {
  run: async (messageText, context) => {
    const { generateAssistantReply } = await import("@/chat/respond");
    return await generateAssistantReply(messageText, context);
  },
};

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
