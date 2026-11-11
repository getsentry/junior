import type { BlockedReport } from "@/chat/agent-invocations/blocked-report";
import {
  getDispatchIdForConversation,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { notifyAutomationBlocked } from "@/chat/automations/blocked-notice";
import { getDb } from "@/chat/db";
import { blockEventAutomation } from "@/chat/event-automations/store";
import { blockScheduledAutomation } from "@/chat/scheduled-automations/tasks";

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
  const dispatch = dispatchId ? await getDispatchRecord(dispatchId) : undefined;
  const source = dispatch?.source;
  const automationId =
    source && "automationId" in source ? source.automationId : undefined;
  if (!dispatch || !source || !automationId) return;
  const kind = source.kind === "scheduled_automation" ? "scheduled" : "event";
  const stored =
    kind === "scheduled"
      ? await blockScheduledAutomation(getDb(), automationId, blocked.missing)
      : await blockEventAutomation(getDb(), automationId, blocked.missing);
  if (stored) {
    await notifyAutomationBlocked({
      automationId,
      dispatchId: dispatch.id,
      kind,
      reason: blocked.missing,
    });
  }
}
