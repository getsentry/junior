import type { SavedTurnResult } from "@/chat/runtime/turn-execution";
import type { TerminalAgentInvocation } from "./types";

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

/**
 * How a finished Turn ends its agent invocation. A failure wins over a
 * blocked report, and a blocked report wins over the reply text. The live
 * save and the recovery path both use this, so they cannot disagree.
 */
export function invocationEndFromTurn(turn: {
  blocked?: { missing: string };
  errorMessage?: string;
  failed: boolean;
  result: string;
}):
  | { errorMessage: string; status: "blocked" | "failed" }
  | { result: string; status: "completed" } {
  if (turn.failed) {
    return {
      errorMessage: turn.errorMessage ?? "Agent invocation failed",
      status: "failed",
    };
  }
  if (turn.blocked) {
    return { errorMessage: turn.blocked.missing, status: "blocked" };
  }
  return { result: turn.result, status: "completed" };
}
