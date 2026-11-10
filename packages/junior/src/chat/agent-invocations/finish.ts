import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import { isResultOwed } from "./list";
import {
  getAgentInvocation,
  isTerminalAgentInvocation,
  saveTerminalAgentInvocation,
  terminalAgentInvocation,
  type AgentInvocationEnd,
} from "./store";
import type { AgentInvocation, TerminalAgentInvocation } from "./types";

/**
 * Append one terminal result to the parent's inbox. The message id is
 * `agent-invocation:<id>:result`, so the inbox drops a second copy.
 */
export type SendAgentResult = (
  invocation: TerminalAgentInvocation,
) => Promise<void>;

/**
 * End one agent invocation. Every terminal path calls this. When the parent
 * is owed a result, it is sent first and the terminal status is saved after
 * it. A crash between the two leaves the agent invocation open, so recovery
 * finishes it again from the saved Turn and report log, and the inbox drops
 * the second copy. `steered` ends a parent task that a running Run read, so
 * that Run answers it. Without `sendResult`, as in the local CLI, nothing is
 * sent.
 */
export async function finishAgentInvocation(
  args: AgentInvocationEnd & {
    invocationId: string;
    nowMs?: number;
    sendResult?: SendAgentResult;
    steered?: true;
  },
): Promise<AgentInvocation | undefined> {
  const current = await getAgentInvocation(args.invocationId);
  if (!current || isTerminalAgentInvocation(current)) {
    return current;
  }
  const nowMs = args.nowMs ?? Date.now();
  const terminal = terminalAgentInvocation(current, args, nowMs);
  const resultSent =
    args.sendResult !== undefined &&
    !args.steered &&
    isResultOwed(
      terminal,
      await getConversationStoppedAtMs(current.childConversationId),
    );
  if (resultSent) {
    await args.sendResult!(terminal);
  }
  return await saveTerminalAgentInvocation(args.invocationId, args, {
    nowMs,
    resultSent,
  });
}
