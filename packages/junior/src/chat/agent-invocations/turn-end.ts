import { getTerminalAssistantMessages } from "@/chat/pi/transcript";
import type { SavedTurnResult } from "@/chat/runtime/turn-execution";
import { getAssistantReplyText } from "@/chat/services/assistant-reply";
import type { TurnRecord } from "@/chat/task-execution/turn-cursor";
import { readTurnAnswer, type Reply } from "@/chat/turn-answer";
import { loadTurnStart } from "@/chat/conversations/turn-lifecycle";
import { savedTurnMessages } from "@/chat/task-execution/turn-membership";
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

/**
 * Read how one saved child Turn ends its agent invocation. A saved `reply`
 * completes it, also when a newer Turn or a lost worker ended the Turn after
 * that, or the Turn is paused. Returns undefined for a paused Turn without a
 * `reply`, which can still resume.
 */
export async function savedTurnEnd(
  turn: TurnRecord,
): Promise<
  | { errorMessage: string; status: "blocked" | "failed" }
  | { result: string; status: "completed" }
  | undefined
> {
  // Read the answer only from this Turn, not from earlier history of a named
  // child.
  const answer = readTurnAnswer(
    savedTurnMessages(
      turn,
      await loadTurnStart(turn.conversationId, turn.turnId),
    ).map(({ message }) => message),
  );
  if (answer && "reply" in answer) {
    return { result: answer.reply.text, status: "completed" };
  }
  if (turn.state === "paused") {
    return undefined;
  }
  if (turn.state !== "completed" || turn.errorMessage) {
    return {
      errorMessage: turn.errorMessage ?? "Agent invocation failed",
      status: "failed",
    };
  }
  if (answer && "blocked" in answer) {
    return { errorMessage: answer.blocked.missing, status: "blocked" };
  }
  // A Turn saved before `reply` existed ends with its final text.
  // TODO(dcramer): Remove one release after getsentry/junior#3160, when no
  // completed row from before it can still be in flight.
  return {
    result: answer
      ? ""
      : getTerminalAssistantMessages(turn.piMessages)
          .map(getAssistantReplyText)
          .filter((text): text is string => text !== undefined)
          .join("\n\n"),
    status: "completed",
  };
}
