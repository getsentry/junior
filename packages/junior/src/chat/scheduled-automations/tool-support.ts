import { createHash } from "node:crypto";
import {
  sourceSchema,
  type Identity,
  type SlackDestination,
  type SlackActor,
  type SlackSource,
  type User,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { z } from "zod";
import { sanitizeScheduledAutomationPrincipal } from "./identity";
import { readScheduledAutomation } from "./tasks";
import type {
  ScheduledAutomation,
  ScheduledAutomationConversationAccess,
  ScheduledAutomationPrincipal,
  ScheduledAutomationStatus,
} from "./types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

export interface SchedulerToolContext {
  actor?: SlackActor;
  now?: () => number;
  source?: SlackSource;
  users: {
    resolveActor(): Promise<{ identity: Identity; user?: User } | undefined>;
  };
  userText?: string;
}

const TASK_ID_PREFIX = "sched";
export const MAX_LISTED_TASKS = 50;
const DEFAULT_SCHEDULE_TIMEZONE = "America/Los_Angeles";

const compactTaskResultSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    status: z.enum(["active", "blocked", "completed", "deleted"]),
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
  })
  .strict();

export const scheduleListToolResultSchema = juniorToolOutputSchema
  .extend({
    automations: z.array(compactTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();
export type CompactTaskResult = z.output<typeof compactTaskResultSchema>;

type SchemaIssue = {
  code: string;
  path: readonly PropertyKey[];
};

/** Normalize scheduled-automation validation failures into the core tool contract. */
export function throwToolInputError(error: string): never {
  throw new ToolInputError(error);
}

/** Require scheduler mutations to stay scoped to the active Slack conversation. */
export function requireActiveConversation(
  context: SchedulerToolContext,
): SlackDestination {
  const parsed = sourceSchema.safeParse(context.source);
  if (!parsed.success) {
    const source = context.source as Partial<SlackSource> | undefined;
    const issues = parsed.error.issues as readonly SchemaIssue[];
    if (!source || source.kind !== "slack") {
      throwToolInputError("No active Slack conversation is available.");
    }
    if (issues.some((issue) => issue.code === "unrecognized_keys")) {
      throwToolInputError(
        "Active Slack conversation must not include unknown fields.",
      );
    }
    if (issues.some((issue) => issue.path[0] === "channelId")) {
      throwToolInputError("Active Slack conversation channel is invalid.");
    }
    if (issues.some((issue) => issue.path[0] === "teamId")) {
      throwToolInputError("Active Slack conversation workspace is invalid.");
    }
    throwToolInputError("No active Slack conversation is available.");
  }

  if (parsed.data.kind !== "slack") {
    throwToolInputError("No active Slack conversation is available.");
  }

  return {
    platform: "slack",
    teamId: parsed.data.teamId,
    channelId: parsed.data.channelId,
    threadTs: parsed.data.threadTs ?? parsed.data.messageTs,
  };
}

/** Require a concrete Slack actor before creating scheduler ownership state. */
export function requireActor(
  context: SchedulerToolContext,
  destination: SlackDestination,
): ScheduledAutomationPrincipal {
  if (
    context.actor?.platform !== "slack" ||
    context.actor.teamId !== destination.teamId
  ) {
    throwToolInputError("No active Slack actor context is available.");
  }
  const userId = context.actor?.userId?.trim();
  if (!userId || userId.toLowerCase() === "unknown") {
    throwToolInputError("No active Slack actor context is available.");
  }

  return sanitizeScheduledAutomationPrincipal({
    slackUserId: userId,
    ...(context.actor?.userName
      ? { userName: context.actor.userName }
      : undefined),
    ...(context.actor?.fullName
      ? { fullName: context.actor.fullName }
      : undefined),
  });
}

function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/** Preserve the active destination's ingress-confirmed access classification. */
export function getConversationAccess(
  destination: SlackDestination,
  source: SlackSource | undefined,
): ScheduledAutomationConversationAccess {
  // TODO(dcramer): Read stored Conversation visibility when users can create
  // Scheduled automations from web and other Conversations. Then this function will
  // not need Slack Source.
  if (isDmChannel(destination.channelId)) {
    return { audience: "direct", visibility: "private" };
  }
  if (destination.channelId.startsWith("G")) {
    return { audience: "group", visibility: "private" };
  }
  return {
    audience: "channel",
    visibility: source?.visibility === "public" ? "public" : "private",
  };
}

/** Keep scheduler management operations bound to the task's current Slack destination. */
export function sameDestination(
  task: ScheduledAutomation,
  destination: SlackDestination,
): boolean {
  const taskDestination = task.destination;
  return (
    taskDestination.platform === "slack" &&
    taskDestination.teamId === destination.teamId &&
    taskDestination.channelId === destination.channelId
  );
}

/** Look up a mutable task only after enforcing active-conversation ownership. */
export async function getWritableTask(args: {
  context: SchedulerToolContext;
  taskId: string;
}): Promise<ScheduledAutomation> {
  const destination = requireActiveConversation(args.context);

  const task = await readScheduledAutomation(getDb(), args.taskId);
  if (!task || task.status === "deleted") {
    throwToolInputError(
      "Scheduled automation was not found in the active Slack conversation.",
    );
  }

  if (!sameDestination(task, destination)) {
    throwToolInputError(
      "Scheduled automation can only be managed from the Slack destination where it currently delivers.",
    );
  }
  return task;
}

/** Project scheduled automation state into the stable model-facing result shape. */
export function compactTask(
  task: ScheduledAutomation,
  requesterSlackUserId?: string,
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
      channel: task.destination.channelId,
      thread: task.destination.threadTs ?? null,
    },
    conversationAccess: task.conversationAccess,
    credentialMode: task.credentialMode,
    isCreator: task.createdBy.slackUserId === requesterSlackUserId,
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
export function scheduleAutomationToolResult(
  task: ScheduledAutomation,
  requesterSlackUserId?: string,
) {
  return { automation: compactTask(task, requesterSlackUserId) } as const;
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
  destination: SlackDestination;
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
): ScheduledAutomationStatus | undefined {
  if (value === "active" || value === "blocked") {
    return value;
  }
  return undefined;
}

/** Centralize scheduler timezone defaulting for all concrete tool entry points. */
export function getDefaultScheduleTimezone(): string {
  return process.env.JUNIOR_TIMEZONE?.trim() || DEFAULT_SCHEDULE_TIMEZONE;
}
