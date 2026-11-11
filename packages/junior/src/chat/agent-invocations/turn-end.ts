import type { SavedTurnResult } from "@/chat/runtime/turn-execution";
import type { Reply } from "@/chat/turn-answer";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

/** Send the `reply` of one child Turn to the parent's inbox. */
export type SendReply = (
  sender: AgentInvocation,
  reply: Reply,
) => Promise<void>;

/**
 * How a terminal agent invocation ends its child Turn. The live save and the
 * recovery paths both use this, so a status cannot end the Turn two ways.
 */
export function agentInvocationTurnEnd(
  terminal: TerminalAgentInvocation,
): SavedTurnResult {
  const finishedAtMs = terminal.terminalAtMs;
  switch (terminal.status) {
    case "completed":
      return {
        finishedAtMs,
        outcome: terminal.result.trim() ? "success" : "no_reply",
      };
    case "stopped":
      return { finishedAtMs, outcome: "cancelled" };
    // A blocked child reported what it needs. That is a result, not a failure.
    case "blocked":
      return { finishedAtMs, outcome: "blocked" };
    case "failed":
      return {
        failureCode: "model_execution_failed",
        finishedAtMs,
        outcome: "failed",
      };
  }
}
