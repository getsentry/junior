import { randomUUID } from "node:crypto";
import {
  PluginToolInputError,
  pluginToolResultSchema,
  sourceSchema,
  type SlackDestination,
  type SlackActor,
  type SlackSource,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { buildCalendarRecurrence, parseScheduleTimestamp } from "./cadence";
import { sanitizeScheduledTaskPrincipal } from "./identity";
import { type SchedulerStore } from "./store";
import type {
  ScheduledCalendarFrequency,
  ScheduledTask,
  ScheduledTaskConversationAccess,
  ScheduledTaskPrincipal,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from "./types";

export interface SchedulerToolContext {
  actor?: SlackActor;
  source?: SlackSource;
  store: SchedulerStore;
  userText?: string;
}

const TASK_ID_PREFIX = "sched";
export const MAX_LISTED_TASKS = 50;
const DEFAULT_SCHEDULE_TIMEZONE = "America/Los_Angeles";

const compactTaskResultSchema = z
  .object({
    id: z.string(),
    status: z.enum(["active", "paused", "blocked", "deleted"]),
    task: z.string(),
    schedule: z.string(),
    timezone: z.string(),
    recurrence: z.unknown().nullable(),
    next_run_at: z.string().nullable(),
    conversation_access: z.unknown().nullable(),
    credential_mode: z.enum(["system", "creator"]),
    last_run_at: z.string().nullable(),
    run_now_at: z.string().nullable(),
  })
  .strict();

const scheduleTaskResultDataSchema = z
  .object({
    ok: z.literal(true),
    task: compactTaskResultSchema,
  })
  .strict();

export const scheduleTaskToolResultSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string(),
  data: scheduleTaskResultDataSchema,
  task: compactTaskResultSchema,
});

const scheduleListResultDataSchema = z
  .object({
    ok: z.literal(true),
    tasks: z.array(compactTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();

export const scheduleListToolResultSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  target: z.string(),
  data: scheduleListResultDataSchema,
  tasks: z.array(compactTaskResultSchema),
  truncated: z.boolean(),
});
export type CompactTaskResult = z.output<typeof compactTaskResultSchema>;

type SchemaIssue = {
  code: string;
  path: readonly PropertyKey[];
};

/** Normalize scheduler validation failures into the plugin tool error contract. */
export function throwToolInputError(error: string): never {
  throw new PluginToolInputError(error);
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
    visibility: source?.type === "pub" ? "public" : "private",
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
    conversation_access: task.conversationAccess ?? null,
    credential_mode: task.credentialMode,
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
  const data = {
    ok: true,
    task,
  } as const;
  return {
    ok: true,
    status: "success",
    target,
    data,
    task,
  } as const;
}

/** Build the structured result for listing scheduler tools. */
export function scheduleListToolResult(args: {
  target: string;
  tasks: CompactTaskResult[];
  truncated: boolean;
}) {
  const data = {
    ok: true,
    tasks: args.tasks,
    truncated: args.truncated,
  } as const;
  return {
    ok: true,
    status: "success",
    target: args.target,
    data,
    tasks: args.tasks,
    truncated: args.truncated,
  } as const;
}

/** Prefix generated scheduler ids so tool results are distinguishable from provider ids. */
export function buildTaskId(): string {
  return `${TASK_ID_PREFIX}_${randomUUID()}`;
}

/** Keep concrete scheduler tools coupled to the injected store, not global state. */
export function schedulerStore(context: SchedulerToolContext): SchedulerStore {
  return context.store;
}

/** Accept only persisted scheduler statuses from model-facing update input. */
export function normalizeStatus(
  value: string | undefined,
): ScheduledTaskStatus | undefined {
  if (value === "active" || value === "paused" || value === "blocked") {
    return value;
  }
  return undefined;
}

function normalizeFrequency(
  value: unknown,
): ScheduledCalendarFrequency | undefined {
  if (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "yearly"
  ) {
    return value;
  }
  return undefined;
}

/** Rebuild recurrence only from validated daily-or-slower schedule requests. */
export function buildRecurrence(args: {
  existing?: ScheduledTaskRecurrence;
  input: {
    recurrence?: unknown;
  };
  nextRunAtMs: number | undefined;
  timezone: string;
}): ScheduledTaskRecurrence | undefined {
  if (args.input.recurrence === null) {
    return undefined;
  }

  const frequency =
    normalizeFrequency(args.input.recurrence) ?? args.existing?.frequency;
  if (!frequency) {
    return undefined;
  }
  if (!args.nextRunAtMs) {
    throwToolInputError("Recurring scheduled tasks require next_run_at.");
  }

  try {
    return buildCalendarRecurrence({
      frequency,
      interval: args.existing?.interval,
      nextRunAtMs: args.nextRunAtMs,
      timezone: args.timezone,
      weekdays: frequency === "weekly" ? args.existing?.weekdays : undefined,
    });
  } catch (error) {
    throwToolInputError(
      error instanceof RangeError
        ? "timezone must be a valid IANA time zone."
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}

/** Reject recurrence values that would exceed the scheduler cadence policy. */
export function validateRecurringFrequencyLimit(input: {
  recurrence?: unknown;
}) {
  if (
    input.recurrence !== undefined &&
    input.recurrence !== null &&
    !normalizeFrequency(input.recurrence)
  ) {
    throwToolInputError(
      "Recurring scheduled tasks can run at most once per day.",
    );
  }
}

/** Force create-tool callers to explicitly choose one-off versus recurring semantics. */
export function validateCreateScheduleKind(input: {
  recurrence?: unknown;
  schedule_kind?: unknown;
}) {
  if (input.schedule_kind === undefined) {
    throwToolInputError("Provide schedule_kind as one_off or recurring.");
  }
  if (
    input.schedule_kind !== "one_off" &&
    input.schedule_kind !== "recurring"
  ) {
    throwToolInputError("schedule_kind must be one_off or recurring.");
  }
  if (
    input.schedule_kind === "one_off" &&
    input.recurrence !== undefined &&
    input.recurrence !== null
  ) {
    throwToolInputError("Omit recurrence when schedule_kind is one_off.");
  }
  if (
    input.schedule_kind === "recurring" &&
    (input.recurrence === undefined || input.recurrence === null)
  ) {
    throwToolInputError("Provide recurrence when schedule_kind is recurring.");
  }
}

/** Detect update inputs that affect calendar recurrence materialization. */
export function shouldRebuildRecurrence(input: {
  next_run_at?: string;
  recurrence?: unknown;
  timezone?: string;
}): boolean {
  return (
    input.next_run_at !== undefined ||
    input.recurrence !== undefined ||
    input.timezone !== undefined
  );
}

/** Centralize scheduler timezone defaulting for all concrete tool entry points. */
export function getDefaultScheduleTimezone(): string {
  return process.env.JUNIOR_TIMEZONE?.trim() || DEFAULT_SCHEDULE_TIMEZONE;
}

/** Validate IANA timezone names before persisting scheduler cadence state. */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

/** Parse model-supplied timestamps without leaking date parser details to tools. */
export function parseNextRunAtMs(
  nextRunAtIso: string | undefined,
): number | undefined {
  try {
    if (nextRunAtIso) {
      return parseScheduleTimestamp(nextRunAtIso);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
