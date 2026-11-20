/** Read-only editor support. Core owns schedules; plugins own Event choices. */
import { automationEventCatalog } from "@/chat/events/catalog";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import {
  compileScheduleIntent,
  ScheduleIntentError,
  type ScheduleIntent,
} from "@/chat/scheduled-automations/schedule-intent";
import { AutomationEditError } from "./edit-rules";
import { readViewerAutomationEdit } from "./edit";
import type { User } from "@sentry/junior-plugin-api";

/**
 * Return only Event types that can start a durable Automation, one entry for
 * each namespace, with the reach of each event.
 */
export function readAutomationEventCatalog() {
  return Object.entries(automationEventCatalog(getEventCatalog())).map(
    ([namespace, registration]) => ({
      namespace,
      displayName: registration.displayName ?? namespace,
      events: Object.fromEntries(
        Object.entries(registration.events).map(([eventType, declaration]) => [
          eventType,
          { reach: declaration.reach },
        ]),
      ),
      anyResourceFields: registration.anyResourceFields,
      resourceTypes: registration.resourceTypes,
    }),
  );
}

/** Preview a creator's draft with the same clock and compiler used by saving. */
export async function previewAutomationSchedule(
  user: User,
  id: string,
  intent: ScheduleIntent,
) {
  const automation = await readViewerAutomationEdit(user, id);
  if (automation.kind !== "scheduled")
    throw new AutomationEditError(
      "Only Scheduled automations have a Schedule.",
      "schedule",
    );
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
