import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import * as z from "zod";
import {
  destinationFilterValue,
  type AutomationDestination,
} from "@/chat/automations/creator";
import type {
  ScheduledAutomation,
  ScheduledAutomationConversationAccess,
} from "./types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";
import { automationTaskDescription } from "@/chat/automations/task";

/** Model-facing shape of one scheduled automation. */
export const compactTaskResultSchema = z
  .object({
    type: z.literal("scheduled"),
    id: z.string(),
    title: z.string().nullable(),
    status: z.enum(["active", "blocked", "paused", "completed", "deleted"]),
    status_reason: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    original_request: z.string().nullable(),
    instruction: z.string(),
    skill: z.string().nullable(),
    schedule: z.string(),
    timezone: z.string(),
    // Uses the keys of the schedule input, so the model can pass the
    // recurrence back to the Automation tools unchanged.
    recurrence: z.unknown().nullable(),
    next_run_at: z.string().nullable(),
    destination: z
      .object({
        id: z.string().min(1),
        channel: z.string().min(1),
        thread: z.string().min(1).nullable(),
      })
      .strict(),
    conversation_access: z
      .object({
        audience: z.enum(["direct", "group", "channel"]),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    credential_mode: z.enum(["system", "creator"]),
    is_creator: z.boolean(),
    created_by: z
      .object({
        name: z.string().min(1).nullable(),
        username: z.string().min(1).nullable(),
      })
      .strict(),
    outcomes: z
      .array(
        z
          .object({
            action: z.literal("send_message"),
            destination: z
              .object({
                channel: z.string().min(1),
                thread: z.string().min(1).nullable(),
              })
              .strict(),
          })
          .strict(),
      )
      .max(5),
    dashboard_url: z.string().url().nullable(),
    last_run_at: z.string().nullable(),
    run_now_at: z.string().nullable(),
  })
  .strict();

/**
 * Return the access class of a Destination. A DM is direct and a group DM is
 * a group. A channel keeps the visibility of the Conversation.
 */
export function getConversationAccess(
  destination: AutomationDestination,
  visibility: "public" | "private" | undefined,
): ScheduledAutomationConversationAccess {
  if (destination.channelId.startsWith("D")) {
    return { audience: "direct", visibility: "private" };
  }
  if (destination.channelId.startsWith("G")) {
    return { audience: "group", visibility: "private" };
  }
  return {
    audience: "channel",
    visibility: visibility === "public" ? "public" : "private",
  };
}

/** Project scheduled automation state into the stable model-facing result shape. */
export function compactTask(task: ScheduledAutomation, isCreator: boolean) {
  return compactTaskResultSchema.parse({
    type: "scheduled",
    id: task.id,
    title: task.title?.trim() || null,
    status: task.status,
    status_reason: task.statusReason ?? null,
    created_at: new Date(task.createdAtMs).toISOString(),
    updated_at: new Date(task.updatedAtMs).toISOString(),
    original_request: task.originalRequest ?? null,
    instruction: task.task.text,
    skill: task.task.skill ?? null,
    schedule: task.schedule.description,
    timezone: task.schedule.timezone,
    recurrence: task.schedule.recurrence
      ? {
          frequency: task.schedule.recurrence.frequency,
          interval: task.schedule.recurrence.interval,
          start_date: task.schedule.recurrence.startDate,
          time: task.schedule.recurrence.time,
          weekdays: task.schedule.recurrence.weekdays,
          month: task.schedule.recurrence.month,
          day_of_month: task.schedule.recurrence.dayOfMonth,
        }
      : null,
    next_run_at: task.nextRunAtMs
      ? new Date(task.nextRunAtMs).toISOString()
      : null,
    destination: {
      id: destinationFilterValue(task.destination),
      channel: task.destination.channelId,
      thread: null,
    },
    conversation_access: task.conversationAccess,
    credential_mode: task.credentialMode,
    is_creator: isCreator,
    created_by: {
      name: task.createdBy.fullName ?? null,
      username: task.createdBy.userName ?? null,
    },
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination).map(
      (outcome) => ({
        action: outcome.action,
        destination: {
          channel: outcome.destination.channelId,
          thread: outcome.destination.threadTs ?? null,
        },
      }),
    ),
    dashboard_url: getDashboardTaskLink(task.id) ?? null,
    last_run_at: task.lastRunAtMs
      ? new Date(task.lastRunAtMs).toISOString()
      : null,
    run_now_at: task.runNowAtMs
      ? new Date(task.runNowAtMs).toISOString()
      : null,
  });
}

/** Build the result of a tool that changed one scheduled automation, with its card. */
export async function scheduleAutomationToolResult(
  conversationId: string,
  task: ScheduledAutomation,
  isCreator: boolean,
) {
  const automation = compactTask(task, isCreator);
  const description = automationTaskDescription(task.task);
  const title =
    automation.title ?? fallbackShortTitle(description, "Scheduled automation");
  const annotation: ObjectAnnotation = {
    kind: "object",
    objectType: "automation",
    label: title,
    key: task.id,
    title,
    url: automation.dashboard_url,
    description,
    status: automation.status,
    trigger:
      task.schedule.kind === "one_off" && task.nextRunAtMs !== undefined
        ? `${new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: task.schedule.timezone,
          }).format(task.nextRunAtMs)} · ${task.schedule.timezone}`
        : automation.schedule,
    warning:
      automation.status === "blocked"
        ? (automation.status_reason ?? "This automation is blocked.")
        : automation.status === "completed"
          ? "This automation has completed."
          : undefined,
  };
  return {
    automation,
    objectCards: await saveObjectAnnotations(conversationId, "junior", [
      annotation,
    ]),
  };
}
