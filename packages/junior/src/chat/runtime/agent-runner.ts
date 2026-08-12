import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  isAgentRunFeatureDisabled,
  type AgentRun,
  type SpawnAgent,
} from "@/chat/agent/types";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";

const AGENT_ABORT_SETTLE_GRACE_MS = 5_000;

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(run: AgentRun): Promise<AgentRunOutcome>;
}

/** Compose the agent executor with stable host dependencies. */
export function createAgentRunner(
  execute: (run: AgentRun, streamFn?: StreamFn) => Promise<AgentRunOutcome>,
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

async function waitForAgentSettlement(
  runPromise: Promise<AgentRunOutcome>,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const settleGrace = new Promise<void>((resolve) => {
    timeoutId = setTimeout(resolve, AGENT_ABORT_SETTLE_GRACE_MS);
    timeoutId.unref?.();
  });
  await Promise.race([
    runPromise.then(
      () => undefined,
      () => undefined,
    ),
    settleGrace,
  ]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
}

/** Abort a timed-out agent run and wait briefly for its work to settle. */
export async function runAgentWithTimeout(
  agentRunner: AgentRunner,
  run: AgentRun,
  timeoutMs: number | undefined,
): Promise<AgentRunOutcome> {
  if (typeof timeoutMs !== "number") {
    return await agentRunner.run(run);
  }

  const timeoutError = new Error(
    `executeAgentRun timed out after ${timeoutMs}ms`,
  );
  const abortController = new AbortController();
  const signal = run.signal
    ? AbortSignal.any([run.signal, abortController.signal])
    : abortController.signal;
  const runPromise = agentRunner.run({ ...run, signal });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } catch (error) {
    if (abortController.signal.aborted) {
      await waitForAgentSettlement(runPromise);
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
