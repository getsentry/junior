import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  isAgentRunFeatureDisabled,
  type AgentRun,
  type SpawnAgent,
} from "@/chat/agent/types";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(run: AgentRun): Promise<AgentRunOutcome>;
}

/** Compose the agent executor with stable host dependencies. */
export function createAgentRunner(
  execute: (
    run: AgentRun,
    streamFn?: StreamFn,
  ) => Promise<AgentRunOutcome>,
  options?: {
    bindSpawnAgent?: (run: AgentRun) => SpawnAgent | undefined;
    streamFn?: StreamFn;
    tracePropagation?: SandboxEgressTracePropagationConfig;
  },
): AgentRunner {
  const streamFn = options?.streamFn;
  const tracePropagation = options?.tracePropagation;
  const bindSpawnAgent = options?.bindSpawnAgent;
  const canBindSpawn =
    Boolean(bindSpawnAgent) && isExperimentalFeatureEnabled("subagents");
  return {
    run: async (run) => {
      const spawnAgent =
        bindSpawnAgent &&
        canBindSpawn &&
        !isAgentRunFeatureDisabled(run.disabledFeatures, "subagents")
          ? bindSpawnAgent(run)
          : undefined;
      const nextRun: AgentRun = {
        ...run,
        environment: {
          ...run.environment,
          sandboxTracePropagation:
            run.environment?.sandboxTracePropagation ?? tracePropagation,
        },
        ...(spawnAgent
          ? {
              durability: {
                ...run.durability,
                spawnAgent,
              },
            }
          : {}),
      };
      return await execute(nextRun, streamFn);
    },
  };
}
