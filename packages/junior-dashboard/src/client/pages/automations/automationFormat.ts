import type { AutomationSummary } from "@sentry/junior/api/schema";
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

/** Format a run time with date, time, and zone for details and tooltips. */
export function formatAutomationRunTime(value: string): string {
  return formatTime(value, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZoneName: "short",
    year: "numeric",
  });
}
