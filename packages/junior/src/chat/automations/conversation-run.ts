import { readAutomationExecutionByConversationId } from "@/chat/automations/execution-stats";
import { readConversationRoot } from "@/chat/conversations/root";

/** The Automation of one run, read from the run's stored record. */
export interface ConversationAutomationRun {
  automationId: string;
  automationRunId?: string;
  /** The run's dispatch, once the run dispatched. */
  dispatchId?: string;
  kind: "scheduled" | "event";
}

/**
 * Return the Automation run of one Automation Conversation. Each run's row
 * links its Conversation before the run's agent acts, and the row lasts as
 * long as the Automation.
 */
export async function readConversationAutomationRun(
  conversationId: string,
): Promise<ConversationAutomationRun | undefined> {
  const run = await readAutomationExecutionByConversationId({
    conversationId,
  });
  return run
    ? {
        automationId: run.automationId,
        automationRunId: run.runId,
        ...(run.dispatchId ? { dispatchId: run.dispatchId } : undefined),
        kind: run.kind,
      }
    : undefined;
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
