import type {
  AutomationExecution,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import type { StatusChipTone } from "../../components/StatusChip";
import { formatTime } from "../../format";

type ScheduledAutomation = Extract<AutomationSummary, { kind: "scheduled" }>;
type EventAutomation = Extract<AutomationSummary, { kind: "event" }>;

/** Show the schedule with its timezone unless the schedule text already names it. */
export function automationScheduleLabel(
  automation: ScheduledAutomation,
): string {
  return automation.schedule.includes(automation.timezone)
    ? automation.schedule
    : `${automation.schedule} (${automation.timezone})`;
}

/** Name event triggers in readable words. */
export function automationEventNames(automation: EventAutomation): string {
  return automation.events
    .map((event) => event.replaceAll(/[._]/g, " "))
    .join(", ");
}

/** Summarize event match conditions as one readable line. */
export function automationEventConditions(automation: EventAutomation): string {
  return Object.entries(automation.match ?? {})
    .map(
      ([field, value]) =>
        `${field}: ${Array.isArray(value) ? value.join(" or ") : String(value)}`,
    )
    .join(" · ");
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
  return timeZone
    ? new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(
        new Date(value),
      )
    : formatTime(value, options);
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
