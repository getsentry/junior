import { and, eq } from "drizzle-orm";
import {
  getDispatchConversationId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import {
  existingConversationId,
  recordAutomationExecution,
} from "@/chat/automations/execution-stats";
import { conversationCostOf } from "@/chat/automations/run-cost";
import { automationVersionOf } from "@/chat/automations/versions";
import type { EventAutomation } from "@/chat/event-automations/types";
import type { JuniorDatabase } from "@/db/db";
import { juniorAutomationRuns } from "@/db/schema/automation-runs";
import { juniorAutomations } from "@/db/schema/automations";
import { mapBounded } from "@/chat/fan-out";

/**
 * Record an event automation run with the Automation version it runs, before
 * its dispatch, so the dispatch can link the run's Conversation as soon as it
 * exists. A retry of the same Event keeps the row it has. A run whose
 * dispatch is never stored fails when the heartbeat settles it.
 */
export async function recordEventAutomationRunStarted(
  db: JuniorDatabase,
  args: { automation: EventAutomation; dispatchId: string; nowMs: number },
): Promise<void> {
  const conversationId = getDispatchConversationId({ id: args.dispatchId });
  await db
    .insert(juniorAutomationRuns)
    .values({
      id: args.dispatchId,
      automationId: args.automation.id,
      automationVersion: automationVersionOf(args.automation),
      conversationId: existingConversationId(conversationId),
      // The dispatch can write usage before this row exists.
      costMicroUsd: conversationCostOf(conversationId),
      startedAtMs: args.nowMs,
      status: "running",
    })
    .onConflictDoNothing({ target: juniorAutomationRuns.id });
}

// The ingest writes a run's row just before its dispatch record, so a
// missing record means a lost dispatch only after this long.
const MISSING_DISPATCH_GRACE_MS = 5 * 60_000;

/**
 * Settle running event automation runs whose dispatch has ended. A run whose
 * dispatch record is still missing after a short grace fails.
 */
export async function settleEventAutomationRuns(
  db: JuniorDatabase,
  nowMs: number,
): Promise<void> {
  const runs = await db
    .select({
      automationId: juniorAutomationRuns.automationId,
      id: juniorAutomationRuns.id,
      startedAtMs: juniorAutomationRuns.startedAtMs,
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
  const dispatches = await mapBounded(runs, (run) => getDispatchRecord(run.id));
  for (const [index, run] of runs.entries()) {
    const dispatch = dispatches[index];
    if (
      !dispatch &&
      (run.startedAtMs ?? 0) > nowMs - MISSING_DISPATCH_GRACE_MS
    ) {
      continue;
    }
    const status = dispatch?.status ?? "failed";
    if (status !== "blocked" && status !== "completed" && status !== "failed") {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Record runs in order, so an Automation's latest run is recorded last.
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
