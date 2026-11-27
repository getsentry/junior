import type { BlockedReport } from "@/chat/child-agents/blocked-report";
import { notifyAutomationBlocked } from "@/chat/automations/blocked-notice";
import { readConversationAutomationRun } from "@/chat/automations/conversation-run";
import { getDb } from "@/chat/db";
import { blockEventAutomation } from "@/chat/event-automations/store";
import { logWarn } from "@/chat/logging";
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
  const automation = await readConversationAutomationRun(conversationId);
  if (!automation) {
    logWarn("automation.block.unresolved", {
      "gen_ai.conversation.id": conversationId,
    });
    return;
  }
  const { automationId, dispatchId, kind } = automation;
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
