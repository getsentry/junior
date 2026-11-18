/** Shared scheduled Automation edits for Slack and the web API. */
import { scheduledAutomationEditSchema } from "@/chat/automations/edit-schema";
import { isDeepStrictEqual } from "node:util";
import {
  AutomationEditError,
  changesAutomationTask,
  editAutomationFields,
} from "@/chat/automations/edit-rules";
import { compileScheduleIntent, ScheduleIntentError } from "./schedule-intent";
import { defaultTimezone } from "@/chat/identities/timezone";
import type { ScheduledAutomation } from "./types";
import type * as z from "zod";

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
        defaultTimezone: current.schedule.timezone || defaultTimezone(),
        intent: input.schedule,
        nowMs,
      });
    } catch (error) {
      if (error instanceof ScheduleIntentError)
        throw new AutomationEditError(error.message, "schedule");
      throw error;
    }
  }
  // A new Schedule changes when creator credentials are used.
  const changesExecution =
    changesAutomationTask(current.task, input) ||
    (compiled !== undefined &&
      !isDeepStrictEqual(compiled.schedule, current.schedule));
  const fields = await editAutomationFields(
    current,
    input,
    isCreator,
    changesExecution,
  );
  return {
    ...current,
    ...fields,
    updatedAtMs: nowMs,
    schedule: compiled?.schedule ?? current.schedule,
    nextRunAtMs: compiled?.nextRunAtMs ?? current.nextRunAtMs,
    // A new Schedule replaces a pending run-now occurrence.
    ...(compiled !== undefined ? { runNowAtMs: undefined } : undefined),
  };
}
