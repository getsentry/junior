import { createHash } from "node:crypto";
import {
  sourceSchema,
  type Identity,
  type SlackDestination,
  type SlackActor,
  type SlackSource,
  type User,
} from "@sentry/junior-plugin-api";
import { getDashboardTaskLink } from "@/chat/slack/dashboard-link";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { z } from "zod";
import { sanitizeScheduledTaskPrincipal } from "./identity";
import { type SchedulerStore } from "./store";
import type {
  ScheduledTask,
  ScheduledTaskConversationAccess,
  ScheduledTaskPrincipal,
  ScheduledTaskStatus,
} from "./types";

export interface SchedulerToolContext {
  actor?: SlackActor;
  now?: () => number;
  source?: SlackSource;
  store: SchedulerStore;
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
    status: z.enum(["active", "blocked", "deleted"]),
    task: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    recurrence: z.unknown().nullable(),
    next_run_at: z.string().nullable(),
    conversation_access: z
      .object({
        audience: z.enum(["direct", "group", "channel"]),
        visibility: z.enum(["private", "public"]),
      })
      .strict(),
    credential_mode: z.enum(["system", "creator"]),
    dashboard_url: z.string().url().nullable(),
    last_run_at: z.string().nullable(),
    run_now_at: z.string().nullable(),
  })
  .strict();

export const scheduleTaskToolResultSchema = juniorToolOutputSchema
  .extend({
    target: z.string(),
    task: compactTaskResultSchema,
  })
  .strict();

export const scheduleListToolResultSchema = juniorToolOutputSchema
  .extend({
    target: z.string(),
    tasks: z.array(compactTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();
export type CompactTaskResult = z.output<typeof compactTaskResultSchema>;

type SchemaIssue = {
  code: string;
  path: readonly PropertyKey[];
};

/** Normalize scheduled-task validation failures into the core tool contract. */
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
    if (!source || source.platform !== "slack") {
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

  if (parsed.data.platform !== "slack") {
    throwToolInputError("No active Slack conversation is available.");
  }

  return {
    platform: "slack",
    teamId: parsed.data.teamId,
    channelId: parsed.data.channelId,
  };
}

/** Require a concrete Slack actor before creating scheduler ownership state. */
export function requireActor(
  context: SchedulerToolContext,
  destination: SlackDestination,
): ScheduledTaskPrincipal {
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

  return sanitizeScheduledTaskPrincipal({
    slackUserId: userId,
    ...(context.actor?.userName ? { userName: context.actor.userName } : {}),
    ...(context.actor?.fullName ? { fullName: context.actor.fullName } : {}),
  });
}

function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/** Preserve the active destination's ingress-confirmed access classification. */
export function getConversationAccess(
  destination: SlackDestination,
  source: SlackSource | undefined,
): ScheduledTaskConversationAccess {
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

/** Keep scheduler management operations bound to the task's original Slack destination. */
export function sameDestination(
  task: ScheduledTask,
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
}): Promise<ScheduledTask> {
  const destination = requireActiveConversation(args.context);

  const task = await schedulerStore(args.context).getTask(args.taskId);
  if (!task || task.status === "deleted") {
    throwToolInputError(
      "Scheduled task was not found in the active Slack conversation.",
    );
  }

  if (!sameDestination(task, destination)) {
    throwToolInputError(
      "Scheduled task can only be managed from the Slack destination where it was created.",
    );
  }
  return task;
}

/** Project scheduled task state into the stable model-facing result shape. */
export function compactTask(task: ScheduledTask): CompactTaskResult {
  return compactTaskResultSchema.parse({
    id: task.id,
    status: task.status,
    task: task.task.text,
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
    conversation_access: task.conversationAccess,
    credential_mode: task.credentialMode,
    dashboard_url: getDashboardTaskLink(task.id) ?? null,
    last_run_at: task.lastRunAtMs
      ? new Date(task.lastRunAtMs).toISOString()
      : null,
    run_now_at: task.runNowAtMs
      ? new Date(task.runNowAtMs).toISOString()
      : null,
  });
}

/** Build the structured result shared by single-task scheduler tools. */
export function scheduleTaskToolResult(
  target: string,
  task: CompactTaskResult,
) {
  return {
    target,
    task,
  } as const;
}

/** Build the structured result for listing scheduler tools. */
export function scheduleListToolResult(args: {
  target: string;
  tasks: CompactTaskResult[];
  truncated: boolean;
}) {
  return {
    target: args.target,
    tasks: args.tasks,
    truncated: args.truncated,
  } as const;
}

/** Build a retry-stable scheduler id scoped to the creating actor and destination. */
export function buildTaskId(args: {
  actor: ScheduledTaskPrincipal;
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

/** Keep concrete scheduler tools coupled to the injected store, not global state. */
export function schedulerStore(context: SchedulerToolContext): SchedulerStore {
  return context.store;
}

/** Accept only persisted scheduler statuses from model-facing update input. */
export function normalizeStatus(
  value: string | undefined,
): ScheduledTaskStatus | undefined {
  if (value === "active" || value === "blocked") {
    return value;
  }
  return undefined;
}

/** Centralize scheduler timezone defaulting for all concrete tool entry points. */
export function getDefaultScheduleTimezone(): string {
  return process.env.JUNIOR_TIMEZONE?.trim() || DEFAULT_SCHEDULE_TIMEZONE;
}
