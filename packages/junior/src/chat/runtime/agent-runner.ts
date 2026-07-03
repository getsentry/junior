import type { ReplyRequestContext } from "@/chat/respond";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(request: ReplyRequestContext): Promise<AgentRunOutcome>;
}

/** Adapt the Pi-facing reply generator behind the runtime-owned runner seam. */
export function createAgentRunner(
  run: AgentRunner["run"],
  options?: { tracePropagation?: SandboxEgressTracePropagationConfig },
): AgentRunner {
  const tracePropagation = options?.tracePropagation;
  if (!tracePropagation) {
    return { run };
  }
  return {
    run: async (request) =>
      await run({
        ...request,
        policy: {
          ...request.policy,
          sandbox: {
            ...request.policy?.sandbox,
            tracePropagation:
              request.policy?.sandbox?.tracePropagation ?? tracePropagation,
          },
        },
      }),
  };
}
