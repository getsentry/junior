/** Own the MCP view of one Automation, shared by the automation tools. */
import * as z from "zod";
import type { AutomationSummary } from "@/api/schema/automation";
import { automationTaskSchema } from "@/chat/automations/task";
import { getDashboardTaskLink } from "@/chat/dashboard-link";

/** MCP view of one Automation. It omits cost and run-count charts. */
export const mcpAutomationSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["scheduled", "event"]),
    title: z.string(),
    task: automationTaskSchema,
    status: z.enum(["active", "blocked", "paused", "completed"]),
    statusReason: z.string().optional(),
    trigger: z
      .string()
      .describe("The schedule, or the events and filters that start a run."),
    nextRunAt: z.string().optional(),
    destination: z.string().describe("Slack channel that gets the results."),
    createdBy: z.string(),
    ownedByYou: z.boolean(),
    lastRunAt: z.string().optional(),
    lastRunStatus: z.enum(["blocked", "completed", "failed"]).optional(),
    lastConversationId: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

function triggerText(automation: AutomationSummary): string {
  if (automation.kind === "scheduled") {
    return `${automation.schedule} (${automation.timezone})`;
  }
  const { events, filters } = automation.trigger;
  return [`${events.join(", ")} on ${automation.resource}`, ...filters].join(
    "; ",
  );
}

/** Map an Automation summary to its MCP view. */
export function mcpAutomation(
  automation: AutomationSummary,
): z.output<typeof mcpAutomationSchema> {
  const url = getDashboardTaskLink(automation.id);
  return {
    id: automation.id,
    kind: automation.kind,
    title: automation.title,
    task: automation.task,
    status: automation.status,
    ...(automation.statusReason
      ? { statusReason: automation.statusReason }
      : undefined),
    trigger: triggerText(automation),
    ...(automation.kind === "scheduled" && automation.nextRunAt
      ? { nextRunAt: automation.nextRunAt }
      : undefined),
    destination: automation.destination.label,
    createdBy: automation.createdBy,
    ownedByYou: automation.ownedByViewer,
    ...(automation.lastRunAt ? { lastRunAt: automation.lastRunAt } : undefined),
    ...(automation.lastRunStatus
      ? { lastRunStatus: automation.lastRunStatus }
      : undefined),
    ...(automation.lastConversationId
      ? { lastConversationId: automation.lastConversationId }
      : undefined),
    ...(url ? { url } : undefined),
  };
}
