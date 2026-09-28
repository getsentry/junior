/** Shared scheduled Automation edits for Slack and the web API. */
import { scheduledAutomationEditSchema } from "@/chat/automations/edit-schema";
import {
  AutomationEditError,
  editAutomationFields,
} from "@/chat/automations/edit-rules";
import { compileScheduleIntent, ScheduleIntentError } from "./schedule-intent";
import { getDefaultScheduleTimezone } from "./tool-support";
import type { ScheduledAutomation } from "./types";
import type { z } from "zod";

/** Build an edit without restarting completed work or changing creator identity. */
export async function editScheduledAutomation(
  current: ScheduledAutomation,
  input: z.output<typeof scheduledAutomationEditSchema>,
  isCreator: boolean,
  nowMs: number,
): Promise<ScheduledAutomation> {
  if (current.status === "completed" || current.status === "deleted") {
    throw new AutomationEditError(
      "Completed scheduled automations cannot be updated. Create a new automation instead.",
    );
  }
  let compiled;
  if (input.schedule !== undefined) {
    try {
      compiled = compileScheduleIntent({
        defaultTimezone:
          current.schedule.timezone || getDefaultScheduleTimezone(),
        intent: input.schedule,
        nowMs,
      });
    } catch (error) {
      if (error instanceof ScheduleIntentError)
        throw new AutomationEditError(error.message, "schedule");
      throw error;
    }
  }
  const nextRunAtMs = compiled?.nextRunAtMs ?? current.nextRunAtMs;
  if (input.status === "active" && !nextRunAtMs) {
    throw new AutomationEditError(
      "Active scheduled automations require a schedule with a future occurrence.",
      "schedule",
    );
  }
  const status = input.status ?? current.status;
  const changesExecution =
    input.instruction !== undefined && input.instruction !== current.task.text;
  return {
    ...current,
    ...(await editAutomationFields(
      current,
      input,
      isCreator,
      changesExecution,
    )),
    updatedAtMs: nowMs,
    schedule: compiled?.schedule ?? current.schedule,
    nextRunAtMs,
    // Metadata edits must not clear a pending occurrence or a blocked reason.
    ...(compiled !== undefined || input.status !== undefined
      ? {
          runNowAtMs:
            status === "active" && !compiled ? current.runNowAtMs : undefined,
          statusReason: status === "blocked" ? current.statusReason : undefined,
        }
      : undefined),
    status,
  };
}
