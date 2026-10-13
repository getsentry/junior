import type { StateAdapter } from "chat";
import { stopConversationWork } from "@/chat/task-execution/store";
import { stopChildAgent } from "./store";

/**
 * Stop one child agent of a parent Conversation and every child agent below
 * it. SQL marks the work `stopped` first. Then a stop request for each
 * Conversation aborts a run that is still working. The worker of each run
 * reads the `stopped` agent invocation and sends no result.
 *
 * Returns undefined when the child does not belong to the parent.
 */
export async function stopAgent(args: {
  childConversationId: string;
  parentConversationId: string;
  state?: StateAdapter;
}): Promise<{ stoppedCount: number } | undefined> {
  const stopped = await stopChildAgent(args);
  if (!stopped) {
    return undefined;
  }
  for (const conversationId of stopped.conversationIds) {
    await stopConversationWork({ conversationId, state: args.state });
  }
  return { stoppedCount: stopped.stoppedCount };
}
