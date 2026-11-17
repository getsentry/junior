import {
  getDispatchIdForConversation,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { readAutomationExecutionByConversationId } from "@/chat/automations/execution-stats";
import { readConversationRoot } from "@/chat/conversations/root";

/** The Automation of one run, read from the run's stored record. */
export interface ConversationAutomationRun {
  automationId: string;
  automationRunId?: string;
  kind: "scheduled" | "event";
}

/**
 * Return the Automation run of one Automation Conversation. The SQL run row
 * lasts as long as the Automation, but a Watch can outlive the dispatch
 * record. The dispatch record covers a run whose row does not link its
 * Conversation yet.
 */
export async function readConversationAutomationRun(
  conversationId: string,
): Promise<ConversationAutomationRun | undefined> {
  const run = await readAutomationExecutionByConversationId({
    conversationId,
  });
  if (run) {
    return {
      automationId: run.automationId,
      automationRunId: run.runId,
      kind: run.kind,
    };
  }
  const dispatchId = getDispatchIdForConversation(conversationId);
  const source = dispatchId
    ? (await getDispatchRecord(dispatchId))?.source
    : undefined;
  if (
    (source?.kind !== "scheduled_automation" &&
      source?.kind !== "event_automation") ||
    !source.automationId
  ) {
    return undefined;
  }
  return {
    automationId: source.automationId,
    ...(source.automationRunId
      ? { automationRunId: source.automationRunId }
      : undefined),
    kind: source.kind === "scheduled_automation" ? "scheduled" : "event",
  };
}

/**
 * Return the Automation run that a Conversation tree belongs to: the run of
 * its root. A child agent at any depth does its root run's work.
 */
export async function readRootAutomationRun(
  conversationId: string,
): Promise<ConversationAutomationRun | undefined> {
  const root = await readConversationRoot(conversationId);
  return await readConversationAutomationRun(
    root?.conversationId ?? conversationId,
  );
}
