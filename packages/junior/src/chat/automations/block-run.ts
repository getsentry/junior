import type { BlockedReport } from "@/chat/agent-invocations/blocked-report";
import {
  getDispatchIdForConversation,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { notifyAutomationBlocked } from "@/chat/automations/blocked-notice";
import { readAutomationExecutionByConversationId } from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import { blockEventAutomation } from "@/chat/event-automations/store";
import { logWarn } from "@/chat/logging";
import { blockScheduledAutomation } from "@/chat/scheduled-automations/tasks";

type RunAutomation = { automationId: string; kind: "scheduled" | "event" };

/**
 * Find the Automation of a run. The SQL run row lasts as long as the
 * Automation, but a Watch can outlive the dispatch record. The dispatch record
 * covers a run whose row does not link its Conversation yet.
 */
async function findRunAutomation(
  conversationId: string,
  dispatchId: string | undefined,
): Promise<RunAutomation | undefined> {
  const run = await readAutomationExecutionByConversationId({
    conversationId,
  });
  if (run) return run;
  const source = dispatchId
    ? (await getDispatchRecord(dispatchId))?.source
    : undefined;
  if (!source || !("automationId" in source) || !source.automationId) {
    return undefined;
  }
  return {
    automationId: source.automationId,
    kind: source.kind === "scheduled_automation" ? "scheduled" : "event",
  };
}

/**
 * Block the Automation of a run from a later Turn of the run, such as a Watch
 * Event or child result Turn. The dispatch Turn blocks through its dispatch
 * outcome. Its creator is told when the block is first stored.
 */
export async function blockRunAutomation(
  conversationId: string,
  blocked: BlockedReport,
): Promise<void> {
  const dispatchId = getDispatchIdForConversation(conversationId);
  const automation = await findRunAutomation(conversationId, dispatchId);
  if (!automation) {
    logWarn("automation.block.unresolved", {
      "gen_ai.conversation.id": conversationId,
    });
    return;
  }
  const { automationId, kind } = automation;
  const stored =
    kind === "scheduled"
      ? await blockScheduledAutomation(getDb(), automationId, blocked.missing)
      : await blockEventAutomation(getDb(), automationId, blocked.missing);
  if (stored) {
    await notifyAutomationBlocked({
      automationId,
      ...(dispatchId ? { dispatchId } : undefined),
      kind,
      reason: blocked.missing,
    });
  }
}
