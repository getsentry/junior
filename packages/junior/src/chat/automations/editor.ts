/** Read-only editor support. Core owns schedules; plugins own Event choices. */
import { pluginEventCatalog } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  type ScheduleIntent,
} from "@/chat/scheduled-automations/schedule-intent";
import { AutomationEditError } from "./edit-rules";
import { readViewerAutomationEdit } from "./edit";
import type { User } from "@sentry/junior-plugin-api";

/** Return only Event types that can start a durable Automation. */
export function readAutomationEventCatalog() {
  return Object.entries(pluginEventCatalog(getEventCatalog())).flatMap(
    ([namespace, registration]) =>
      registration.resourceTypes.map((resource) => ({
        namespace,
        ...resource,
      })),
  );
}

/** Preview a creator's draft with the same clock and compiler used by saving. */
export async function previewAutomationSchedule(
  user: User,
  id: string,
  intent: ScheduleIntent,
) {
  const automation = await readViewerAutomationEdit(user, "scheduled", id);
  if (automation.kind !== "scheduled")
    throw new Error("Expected scheduled Automation");
  if (automation.status === "completed")
    throw new AutomationEditError(
      "Completed automations cannot be edited.",
      "schedule",
    );
  try {
    return compileScheduleIntent({
      defaultTimezone: automation.schedule.timezone,
      intent,
      nowMs: Date.now(),
    });
  } catch (error) {
    if (error instanceof ScheduleIntentError)
      throw new AutomationEditError(error.message, "schedule");
    throw error;
  }
}
