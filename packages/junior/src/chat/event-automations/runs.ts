import { and, eq } from "drizzle-orm";
import {
  getDispatchConversationId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import {
  existingConversationId,
  recordAutomationExecution,
} from "@/chat/automations/execution-stats";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { juniorAutomations } from "@/db/schema/automations";

/**
 * Record a dispatched event automation run and link its Conversation when it
 * exists. The dispatch can finish before this write, so a stored run, or a
 * retry of the same Event, keeps the row it has.
 */
export async function recordEventAutomationRunStarted(
  db: JuniorDatabase,
  args: { automationId: string; dispatchId: string; nowMs: number },
): Promise<void> {
  await db
    .insert(juniorAutomationRuns)
    .values({
      id: args.dispatchId,
      automationId: args.automationId,
      conversationId: existingConversationId(
        getDispatchConversationId({ id: args.dispatchId }),
      ),
      startedAtMs: args.nowMs,
      status: "running",
    })
    .onConflictDoNothing({ target: juniorAutomationRuns.id });
}

/**
 * Settle running event automation runs whose dispatch has ended. A run whose
 * dispatch record is gone fails.
 */
export async function settleEventAutomationRuns(
  db: JuniorDatabase,
  nowMs: number,
): Promise<void> {
  const runs = await db
    .select({
      automationId: juniorAutomationRuns.automationId,
      id: juniorAutomationRuns.id,
    })
    .from(juniorAutomationRuns)
    .innerJoin(
      juniorAutomations,
      eq(juniorAutomations.id, juniorAutomationRuns.automationId),
    )
    .where(
      and(
        eq(juniorAutomations.kind, "event"),
        eq(juniorAutomationRuns.status, "running"),
      ),
    );
  for (const run of runs) {
    const dispatch = await getDispatchRecord(run.id);
    const status = dispatch?.status ?? "failed";
    if (status !== "blocked" && status !== "completed" && status !== "failed") {
      continue;
    }
    await recordAutomationExecution(run.automationId, {
      conversationId: getDispatchConversationId({ id: run.id }),
      errorMessage: dispatch
        ? dispatch.errorMessage
        : "Event automation dispatch record is missing.",
      executionId: run.id,
      nowMs: dispatch?.updatedAtMs ?? nowMs,
      status,
    });
  }
}
