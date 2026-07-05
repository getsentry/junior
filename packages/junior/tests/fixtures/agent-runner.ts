import type { AgentRunner } from "@/chat/runtime/agent-runner";

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
 * Flatten a grouped run request so tests can assert on the legacy flat field
 * surface without hand-copying the group spreads at every mock boundary.
 */
export function flattenAgentRunRequestForTest(
  request: Parameters<AgentRunner["run"]>[0],
) {
  return {
    ...request.input,
    ...request.routing,
    ...(request.policy ?? {}),
    ...(request.state ?? {}),
    ...(request.observers ?? {}),
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
