import type { AgentRunResult } from "@/chat/services/turn-result";
import type { AgentTurnUsage } from "@/chat/usage";

/**
 * How an agent run ended. `completed` carries the terminal result (success or
 * failure — `result.diagnostics` distinguishes them). `suspended` means the run
 * persisted an awaiting_resume session record and stopped at a safe boundary;
 * the caller resumes it by scheduling a continuation against `resumeVersion`,
 * the session record's optimistic-concurrency version. `awaiting_auth` means
 * the run parked for user authorization.
 */
export type AgentRunOutcome =
  | { status: "completed"; result: AgentRunResult }
  | {
      status: "suspended";
      resumeVersion: number;
      usage?: AgentTurnUsage;
    }
  | {
      status: "awaiting_auth";
      providerDisplayName: string;
      usage?: AgentTurnUsage;
    };

/** Wrap a terminal result (successful or failed per its diagnostics) as an outcome. */
export function completedAgentRun(result: AgentRunResult): AgentRunOutcome {
  return { status: "completed", result };
}
