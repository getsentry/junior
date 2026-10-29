import type { JuniorSqlDatabase } from "@/db/db";
import { resolveMentions } from "../mentions";
import type { AutomationSummary } from "../schema/automation";

/** Attach the people that each Automation instruction mentions, resolved at read time. */
export async function attachAutomationMentions(
  executor: JuniorSqlDatabase,
  automations: readonly AutomationSummary[],
): Promise<AutomationSummary[]> {
  const mentions = await resolveMentions(
    executor,
    automations.map((automation) => ({
      tenantId: automation.destination.teamId,
      texts: [automation.instruction],
    })),
  );
  return automations.map((automation, index) =>
    mentions[index]!.length > 0
      ? { ...automation, mentions: mentions[index] }
      : automation,
  );
}
