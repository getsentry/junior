import { hasReportingAgentInvocationSince } from "@/chat/agent-invocations/store";

/**
 * Decide whether a reply that the agent marked quiet stays quiet. A card
 * means someone must look, so it always delivers. An Event Turn may be quiet.
 * A person's Turn may be quiet only when it started a child agent whose
 * result still comes back: that result tells the person, so the status that
 * only says the work started notifies nobody.
 */
export async function isQuietReply(args: {
  conversationId: string;
  eventTurn: boolean;
  hasCards: boolean;
  marked: boolean;
  /** When this Turn's run started. One Turn runs at a time. */
  runStartedAtMs: number;
}): Promise<boolean> {
  if (!args.marked || args.hasCards) return false;
  if (args.eventTurn) return true;
  return await hasReportingAgentInvocationSince(
    args.conversationId,
    args.runStartedAtMs,
  );
}
