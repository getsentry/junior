import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { z } from "zod";
import {
  destinationFilterValue,
  type AutomationDestination,
} from "@/chat/automations/creator";
import type {
  ScheduledAutomation,
  ScheduledAutomationConversationAccess,
} from "./types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

/** Model-facing shape of one scheduled automation. */
export const compactTaskResultSchema = z
  .object({
    type: z.literal("scheduled"),
    id: z.string(),
    title: z.string().nullable(),
    status: z.enum(["active", "blocked", "paused", "completed", "deleted"]),
    statusReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    originalRequest: z.string().nullable(),
    instruction: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    recurrence: z.unknown().nullable(),
    nextRunAt: z.string().nullable(),
    destination: z
      .object({
        id: z.string().min(1),
        channel: z.string().min(1),
        thread: z.string().min(1).nullable(),
      })
      .strict(),
    conversationAccess: z
      .object({
        audience: z.enum(["direct", "group", "channel"]),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    credentialMode: z.enum(["system", "creator"]),
    isCreator: z.boolean(),
    createdBy: z
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
    dashboardUrl: z.string().url().nullable(),
    lastRunAt: z.string().nullable(),
    runNowAt: z.string().nullable(),
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
    statusReason: task.statusReason ?? null,
    createdAt: new Date(task.createdAtMs).toISOString(),
    updatedAt: new Date(task.updatedAtMs).toISOString(),
    originalRequest: task.originalRequest ?? null,
    instruction: task.task.text,
    schedule: task.schedule.description,
    timezone: task.schedule.timezone,
    recurrence: task.schedule.recurrence
      ? {
          frequency: task.schedule.recurrence.frequency,
          interval: task.schedule.recurrence.interval,
          startDate: task.schedule.recurrence.startDate,
          time: task.schedule.recurrence.time,
          weekdays: task.schedule.recurrence.weekdays,
          month: task.schedule.recurrence.month,
          dayOfMonth: task.schedule.recurrence.dayOfMonth,
        }
      : null,
    nextRunAt: task.nextRunAtMs
      ? new Date(task.nextRunAtMs).toISOString()
      : null,
    destination: {
      id: destinationFilterValue(task.destination),
      channel: task.destination.channelId,
      thread: null,
    },
    conversationAccess: task.conversationAccess,
    credentialMode: task.credentialMode,
    isCreator,
    createdBy: {
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
    dashboardUrl: getDashboardTaskLink(task.id) ?? null,
    lastRunAt: task.lastRunAtMs
      ? new Date(task.lastRunAtMs).toISOString()
      : null,
    runNowAt: task.runNowAtMs ? new Date(task.runNowAtMs).toISOString() : null,
  });
}

/** Build the result of a tool that changed one scheduled automation, with its card. */
export async function scheduleAutomationToolResult(
  conversationId: string,
  task: ScheduledAutomation,
  isCreator: boolean,
) {
  const automation = compactTask(task, isCreator);
  const title =
    automation.title ??
    fallbackShortTitle(automation.instruction, "Scheduled automation");
  const annotation: ObjectAnnotation = {
    kind: "object",
    objectType: "automation",
    label: title,
    key: task.id,
    title,
    url: automation.dashboardUrl,
    description: automation.instruction,
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
        ? (automation.statusReason ?? "This automation is blocked.")
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
