import {
  isAgentRunFeatureDisabled,
  type AgentRunRequest,
  type SpawnAgent,
} from "@/chat/agent/request";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}

/** Adapt the Pi-facing agent-run executor behind the runtime-owned runner seam. */
export function createAgentRunner(
  run: AgentRunner["run"],
  options?: {
    bindSpawnAgent?: (request: AgentRunRequest) => SpawnAgent | undefined;
    tracePropagation?: SandboxEgressTracePropagationConfig;
  },
): AgentRunner {
  const tracePropagation = options?.tracePropagation;
  const bindSpawnAgent = options?.bindSpawnAgent;
  if (!tracePropagation && !bindSpawnAgent) {
    return { run };
  }
  return {
    run: async (request) => {
      const spawnAgent =
        bindSpawnAgent &&
        !isAgentRunFeatureDisabled(request.policy, "subagents")
          ? bindSpawnAgent(request)
          : undefined;
      return await run({
        ...request,
        policy: {
          ...request.policy,
          sandboxTracePropagation:
            request.policy?.sandboxTracePropagation ?? tracePropagation,
        },
        ...(spawnAgent
          ? {
              durability: {
                ...request.durability,
                spawnAgent,
              },
            }
          : {}),
      });
    },
  };
}
