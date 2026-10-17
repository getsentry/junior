/** Shared SQL column values for both Automation kinds. */
import type { juniorAutomations } from "@/db/schema/automations";

type CopiedColumns = Pick<
  typeof juniorAutomations.$inferInsert,
  "channelId" | "creatorSlackUserId" | "instruction" | "teamId"
>;

/**
 * Copy the nested Automation values that queries filter, join, or search on
 * into their SQL columns. Call it on every write so the copies stay current.
 */
export function automationCopiedColumns(task: {
  createdBy: { slackUserId: string };
  destination: { channelId: string; teamId: string };
  task: { text: string };
}): CopiedColumns {
  return {
    channelId: task.destination.channelId,
    creatorSlackUserId: task.createdBy.slackUserId,
    instruction: task.task.text,
    teamId: task.destination.teamId,
  };
}
