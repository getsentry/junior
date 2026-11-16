import { getSqlExecutor } from "@/chat/db";
import { renderPlanSnapshot } from "@/chat/plan/prompt";
import { listPlanItems } from "@/chat/plan/store";

/**
 * Append one `<plan>` snapshot of the open items, read from the database, to
 * a compaction summary, so the plan and its version survive the history
 * replacement.
 */
export async function appendPlanSnapshot(
  summaryText: string,
  conversationId: string,
): Promise<string> {
  const snapshot = renderPlanSnapshot(
    await listPlanItems(getSqlExecutor(), conversationId),
  );
  return snapshot ? `${summaryText}\n\n${snapshot}` : summaryText;
}
