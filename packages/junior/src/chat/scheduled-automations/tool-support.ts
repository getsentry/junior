import {
  ownedObjectAnnotationSchema,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { createHash } from "node:crypto";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { z } from "zod";
import {
  destinationFilterValue,
  type AutomationDestination,
} from "@/chat/automations/creator";
import type {
  ScheduledAutomation,
  ScheduledAutomationConversationAccess,
  ScheduledAutomationPrincipal,
} from "./types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const TASK_ID_PREFIX = "sched";

const compactTaskResultSchema = z
  .object({
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

export const scheduleAutomationToolResultSchema = juniorToolOutputSchema
  .extend({
    automation: compactTaskResultSchema,
    objectCards: z.array(ownedObjectAnnotationSchema).optional(),
  })
  .strict();

export const scheduleListToolResultSchema = juniorToolOutputSchema
  .extend({
    automations: z.array(compactTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();
export type CompactTaskResult = z.output<typeof compactTaskResultSchema>;

/** Normalize scheduled-automation validation failures into the core tool contract. */
export function throwToolInputError(error: string): never {
  throw new ToolInputError(error);
}

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

/** Return whether the task delivers to this Destination. */
export function sameDestination(
  task: ScheduledAutomation,
  destination: AutomationDestination,
): boolean {
  return (
    task.destination.platform === destination.platform &&
    task.destination.teamId === destination.teamId &&
    task.destination.channelId === destination.channelId
  );
}

/** Project scheduled automation state into the stable model-facing result shape. */
export function compactTask(
  task: ScheduledAutomation,
  isCreator: boolean,
): CompactTaskResult {
  return compactTaskResultSchema.parse({
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

/** Build the structured result shared by single-task scheduler tools. */
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

/** Build the structured result for listing scheduler tools. */
export function scheduleListToolResult(args: {
  automations: CompactTaskResult[];
  truncated: boolean;
}) {
  return {
    automations: args.automations,
    truncated: args.truncated,
  } as const;
}

/** Build a retry-stable scheduler id scoped to the creating actor and destination. */
export function buildTaskId(args: {
  actor: ScheduledAutomationPrincipal;
  destination: AutomationDestination;
  toolCallId: string | undefined;
}): string {
  const toolCallId = args.toolCallId?.trim();
  if (!toolCallId) {
    throw new Error("Scheduler task creation requires a tool-call identity.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actor: args.actor.slackUserId,
        channel: args.destination.channelId,
        operation: toolCallId,
        platform: args.destination.platform,
        team: args.destination.teamId,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `${TASK_ID_PREFIX}_${digest}`;
}

/** Accept only persisted scheduler statuses from model-facing update input. */
export function normalizeStatus(
  value: string | undefined,
): "active" | "blocked" | undefined {
  if (value === "active" || value === "blocked") {
    return value;
  }
  return undefined;
}
