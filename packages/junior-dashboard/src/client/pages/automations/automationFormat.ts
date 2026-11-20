import type {
  AutomationExecution,
  AutomationRun,
  AutomationListItem,
} from "@sentry/junior/api/schema";
import type { StatusChipTone } from "../../components/StatusChip";
import { formatTime } from "../../time";

type ScheduledAutomation = Extract<AutomationListItem, { kind: "scheduled" }>;

/** Show the schedule with its timezone unless the schedule text already names it. */
export function automationScheduleLabel(
  automation: ScheduledAutomation,
): string {
  return automation.schedule.includes(automation.timezone)
    ? automation.schedule
    : `${automation.schedule} (${automation.timezone})`;
}

/** Format a run in an explicit timezone, or the dashboard timezone by default. */
export function formatAutomationRunTime(
  value: string,
  timeZone?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  };
  return formatTime(value, timeZone ? { ...options, timeZone } : options);
}

/** Map a run outcome to its status color. */
export function automationRunStatusTone(
  status: AutomationExecution["status"],
): StatusChipTone {
  if (status === "failed") return "danger";
  if (status === "blocked") return "warning";
  return "success";
}

/** Name a run by its Conversation title, else by its Automation. */
export function automationRunTitle(
  run: AutomationExecution,
  automationTitle: string,
): string {
  return (
    run.title?.trim() ||
    (run.conversationId ? automationTitle : "No conversation")
  );
}

/** Name the Automation on one of its runs, so run details can show it. */
export function automationRunOf(
  execution: AutomationExecution,
  automation: AutomationListItem,
): AutomationRun {
  return {
    ...execution,
    automationId: automation.id,
    automationTitle: automation.title,
    kind: automation.kind,
  };
}
