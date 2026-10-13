import type { StateAdapter } from "chat";
import { stopConversationWork } from "@/chat/task-execution/store";
import { stopChildAgentInvocations } from "./store";
import { recordSubagentEnded } from "./work";

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. The parent gets no result. SQL stops the work first. Then a
 * Conversation stop request aborts each run that is still working.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopChildAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<{ stoppedCount: number } | undefined> {
  const result = await stopChildAgentInvocations(args);
  if (!result) {
    return undefined;
  }
  for (const invocation of result.stopped) {
    await recordSubagentEnded(invocation);
  }
  for (const conversationId of result.conversationIds) {
    await stopConversationWork({ conversationId, state: args.state });
  }
  return { stoppedCount: result.stopped.length };
}
