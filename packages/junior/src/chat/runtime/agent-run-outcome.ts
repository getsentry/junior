import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentTurnUsage } from "@/chat/usage";

/**
 * How an agent run ended. `completed` carries the terminal result (success or
 * failure — `result.diagnostics` distinguishes them). `suspended` means the run
 * persisted an paused session record and stopped at a safe boundary;
 * the caller resumes it by scheduling a continuation against `resumeVersion`,
 * the session record's optimistic-concurrency version. `awaiting_auth` means
 * the run parked for user authorization.
 */
/** Why a run parked at a safe boundary and may continue. */
export type AgentSuspensionReason = "timeout" | "yield" | "retry";

export type AgentRunOutcome =
  | { status: "completed"; result: AgentRunResult }
  | {
      status: "suspended";
      /** Why this slice stopped. Callers use this to choose wake vs yield. */
      reason: AgentSuspensionReason;
      resumeVersion: number;
      usage?: AgentTurnUsage;
    }
  | {
      status: "awaiting_auth";
      providerDisplayName: string;
      requestText?: string;
      usage?: AgentTurnUsage;
    };

/** Wrap a terminal result (successful or failed per its diagnostics) as an outcome. */
export function completedAgentRun(result: AgentRunResult): AgentRunOutcome {
  return { status: "completed", result };
}
