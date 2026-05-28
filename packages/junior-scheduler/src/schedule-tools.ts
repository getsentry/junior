import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  AgentPluginToolInputError,
  type AgentPluginRequester,
  type AgentPluginState,
  type AgentPluginToolDefinition,
} from "@sentry/junior-plugin-api";
import { buildCalendarRecurrence, parseScheduleTimestamp } from "./cadence";
import { createSchedulerStore } from "./store";
import { SCHEDULED_TASK_SYSTEM_ACTOR } from "./types";
import type {
  ScheduledCalendarFrequency,
  ScheduledTask,
  ScheduledTaskConversationAccess,
  ScheduledTaskCredentialSubject,
  ScheduledTaskDestination,
  ScheduledTaskPrincipal,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from "./types";

export interface SchedulerToolContext {
  channelCapabilities: {
    canAddReactions: boolean;
    canCreateCanvas: boolean;
    canPostToChannel: boolean;
  };
  channelId?: string;
  messageTs?: string;
  requester?: AgentPluginRequester;
  state: AgentPluginState;
  teamId?: string;
  threadTs?: string;
  userText?: string;
}

const TASK_ID_PREFIX = "sched";
const MAX_LISTED_TASKS = 50;
const DEFAULT_SCHEDULE_TIMEZONE = "America/Los_Angeles";
const ACTIVE_DESTINATION_GUIDELINE =
  "Only manage tasks for the active Slack DM or channel; never target an existing thread, another channel, or another user's DM.";
const ACTIVE_TASK_ID_GUIDELINE =
  "Use only task IDs returned from this active destination.";
const RECURRING_GUIDELINE =
  "Omit recurrence for one-time requests like 'in 1 minute', 'tomorrow', or a specific date; provide recurrence only for requests that explicitly repeat.";

const recurrenceInputSchema = Type.Union([
  Type.Literal("daily"),
  Type.Literal("weekly"),
  Type.Literal("monthly"),
  Type.Literal("yearly"),
]);

function throwToolInputError(error: string): never {
  throw new AgentPluginToolInputError(error);
}

function requireActiveDestination(
  context: SchedulerToolContext,
): ScheduledTaskDestination {
  const channelId = normalizeSlackConversationId(context.channelId);
  if (!channelId) {
    throwToolInputError("No active Slack channel context is available.");
  }
  if (!context.teamId) {
    throwToolInputError("No active Slack workspace context is available.");
  }
  if (!isSlackTeamId(context.teamId)) {
    throwToolInputError("Active Slack workspace context is invalid.");
  }

  return {
    platform: "slack",
    teamId: context.teamId,
    channelId,
  };
}

function requireRequester(
  context: SchedulerToolContext,
): ScheduledTaskPrincipal {
  const userId = context.requester?.userId;
  if (!userId) {
    throwToolInputError("No active Slack requester context is available.");
  }

  return {
    slackUserId: userId,
    ...(context.requester?.userName
      ? { userName: context.requester.userName }
      : {}),
    ...(context.requester?.fullName
      ? { fullName: context.requester.fullName }
      : {}),
  };
}

function tool<TInput = any>(
  definition: AgentPluginToolDefinition<TInput>,
): AgentPluginToolDefinition<TInput> {
  return definition;
}

function normalizeSlackConversationId(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("slack:")) return trimmed;

  const parts = trimmed.split(":");
  return parts[1]?.trim() || undefined;
}

function isDmChannel(channelId: string): boolean {
  return normalizeSlackConversationId(channelId)?.startsWith("D") ?? false;
}

function isSlackTeamId(value: string): boolean {
  return /^T[A-Z0-9]+$/.test(value);
}

function getConversationAccess(
  destination: ScheduledTaskDestination,
): ScheduledTaskConversationAccess {
  if (isDmChannel(destination.channelId)) {
    return { audience: "direct", visibility: "private" };
  }
  if (destination.channelId.startsWith("G")) {
    return { audience: "group", visibility: "private" };
  }
  if (destination.channelId.startsWith("C")) {
    return { audience: "channel", visibility: "unknown" };
  }
  return { audience: "channel", visibility: "unknown" };
}

function getCredentialSubject(args: {
  access: ScheduledTaskConversationAccess;
  requester: ScheduledTaskPrincipal;
}): ScheduledTaskCredentialSubject | undefined {
  if (
    args.access.audience !== "direct" ||
    args.access.visibility !== "private"
  ) {
    return undefined;
  }
  return {
    type: "user",
    userId: args.requester.slackUserId,
    allowedWhen: "private-direct-conversation",
  };
}

function sameDestination(
  task: ScheduledTask,
  destination: ScheduledTaskDestination,
): boolean {
  return (
    task.destination.platform === destination.platform &&
    task.destination.teamId === destination.teamId &&
    task.destination.channelId === destination.channelId
  );
}

async function getWritableTask(args: {
  context: SchedulerToolContext;
  taskId: string;
}): Promise<ScheduledTask> {
  const destination = requireActiveDestination(args.context);

  const task = await createSchedulerStore(args.context.state).getTask(
    args.taskId,
  );
  if (!task || task.status === "deleted") {
    throwToolInputError(
      "Scheduled task was not found in the active destination.",
    );
  }

  if (!sameDestination(task, destination)) {
    throwToolInputError(
      "Scheduled task can only be managed from the Slack destination where it was created.",
    );
  }
  return task;
}

function compactTask(task: ScheduledTask): Record<string, unknown> {
  return {
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
    credential_subject: task.credentialSubject
      ? {
          type: task.credentialSubject.type,
          allowed_when: task.credentialSubject.allowedWhen,
        }
      : null,
    last_run_at: task.lastRunAtMs
      ? new Date(task.lastRunAtMs).toISOString()
      : null,
    run_now_at: task.runNowAtMs
      ? new Date(task.runNowAtMs).toISOString()
      : null,
    version: task.version,
  };
}

function buildTaskId(): string {
  return `${TASK_ID_PREFIX}_${randomUUID()}`;
}

function normalizeStatus(
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

function buildRecurrence(args: {
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

function validateRecurringFrequencyLimit(input: { recurrence?: unknown }) {
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

function shouldRebuildRecurrence(input: {
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

function getDefaultScheduleTimezone(): string {
  return process.env.JUNIOR_TIMEZONE?.trim() || DEFAULT_SCHEDULE_TIMEZONE;
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function parseNextRunAtMs(
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

/** Create a tool that stores a scheduled task for the active Slack context. */
export function createSlackScheduleCreateTaskTool(
  context: SchedulerToolContext,
) {
  return tool({
    description:
      "Create a scheduled Junior task in the active Slack conversation.",
    promptSnippet: "create future or recurring Junior work here",
    promptGuidelines: [
      "Use only when the user explicitly asks Junior to do work later or on a recurring cadence.",
      ACTIVE_DESTINATION_GUIDELINE,
      RECURRING_GUIDELINE,
      "When the user's scheduling intent is clear, create the task immediately without asking for confirmation.",
      "Ask for confirmation only when the task contract, schedule, or active destination is ambiguous.",
      "Recurring tasks can run at most once per day; use only daily, weekly, monthly, or yearly recurrence frequencies.",
      "Provide next_run_at as an exact ISO timestamp computed from the user's requested schedule.",
      "Provide recurrence only for repeating schedules.",
    ],
    inputSchema: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 4000 }),
      schedule: Type.String({ minLength: 1, maxLength: 300 }),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      next_run_at: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Exact next run time as an ISO timestamp, computed from the user's requested schedule.",
        }),
      ),
      recurrence: Type.Optional(recurrenceInputSchema),
    }),
    execute: async (input) => {
      const destination = requireActiveDestination(context);
      const requester = requireRequester(context);

      const nowMs = Date.now();
      const timezone = input.timezone ?? getDefaultScheduleTimezone();
      validateRecurringFrequencyLimit(input);
      if (!isValidTimeZone(timezone)) {
        throwToolInputError("timezone must be a valid IANA time zone.");
      }
      const nextRunAtMs = parseNextRunAtMs(input.next_run_at);
      if (!nextRunAtMs) {
        throwToolInputError("Provide next_run_at as a valid ISO timestamp.");
      }
      const recurrence = buildRecurrence({
        input,
        nextRunAtMs,
        timezone,
      });
      const conversationAccess = getConversationAccess(destination);
      const credentialSubject = getCredentialSubject({
        access: conversationAccess,
        requester,
      });

      const task: ScheduledTask = {
        id: buildTaskId(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: requester,
        conversationAccess,
        ...(credentialSubject ? { credentialSubject } : {}),
        destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs,
        originalRequest: context.userText,
        schedule: {
          description: input.schedule,
          timezone,
          kind: recurrence ? "recurring" : "one_off",
          recurrence,
        },
        status: "active",
        task: {
          text: input.task,
        },
        version: 1,
      };

      await createSchedulerStore(context.state).saveTask(task);
      return {
        ok: true,
        task: compactTask(task),
      };
    },
  });
}

/** Create a tool that lists scheduled tasks for the active Slack destination. */
export function createSlackScheduleListTasksTool(
  context: SchedulerToolContext,
) {
  return tool({
    description:
      "List scheduled Junior tasks for the active Slack conversation.",
    promptSnippet: "list schedules for this Slack destination",
    promptGuidelines: [
      "Use when the user asks what is scheduled here or needs task IDs before editing, deleting, or running schedules.",
      ACTIVE_DESTINATION_GUIDELINE,
    ],
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: Type.Object({}),
    execute: async () => {
      const destination = requireActiveDestination(context);

      const tasks = await createSchedulerStore(context.state).listTasksForTeam(
        destination.teamId,
      );
      const matching = tasks.filter((task) =>
        sameDestination(task, destination),
      );
      const visible = matching.slice(0, MAX_LISTED_TASKS).map(compactTask);

      return {
        ok: true,
        tasks: visible,
        truncated: matching.length > visible.length,
      };
    },
  });
}

/** Create a tool that edits a scheduled task in the active Slack destination. */
export function createSlackScheduleUpdateTaskTool(
  context: SchedulerToolContext,
) {
  return tool({
    description: "Edit, pause, resume, or reschedule a Junior scheduled task.",
    promptSnippet: "edit/pause/resume one schedule in this Slack destination",
    promptGuidelines: [
      ACTIVE_TASK_ID_GUIDELINE,
      ACTIVE_DESTINATION_GUIDELINE,
      RECURRING_GUIDELINE,
      "Do not move scheduled tasks across conversations.",
      "Provide next_run_at as an exact ISO timestamp when changing the next run.",
      "Set recurrence to null when converting a recurring task to one-time.",
      "Set status to active, paused, or blocked when the user asks to resume, pause, or block a task.",
    ],
    inputSchema: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      schedule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      next_run_at: Type.Optional(Type.String({ minLength: 1 })),
      recurrence: Type.Optional(
        Type.Union([recurrenceInputSchema, Type.Null()]),
      ),
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("paused"),
          Type.Literal("blocked"),
        ]),
      ),
    }),
    execute: async (input) => {
      const lookup = await getWritableTask({
        context,
        taskId: input.task_id,
      });

      const timezone = input.timezone ?? lookup.schedule.timezone;
      validateRecurringFrequencyLimit(input);
      if (!isValidTimeZone(timezone)) {
        throwToolInputError("timezone must be a valid IANA time zone.");
      }
      const parsedNextRunAtMs = parseNextRunAtMs(input.next_run_at);
      const nextRunAtMs = input.next_run_at
        ? parsedNextRunAtMs
        : lookup.nextRunAtMs;
      if (input.next_run_at && !nextRunAtMs) {
        throwToolInputError("Provide next_run_at as a valid ISO timestamp.");
      }

      const status = normalizeStatus(input.status);
      if (input.status && !status) {
        throwToolInputError("status must be active, paused, or blocked.");
      }
      if (status === "active" && !nextRunAtMs) {
        throwToolInputError(
          "Active scheduled tasks require next_run_at when no next run is stored.",
        );
      }
      const recurrence = shouldRebuildRecurrence(input)
        ? buildRecurrence({
            existing: lookup.schedule.recurrence,
            input,
            nextRunAtMs,
            timezone,
          })
        : lookup.schedule.recurrence;
      const nextStatus = status ?? lookup.status;

      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: Date.now(),
        nextRunAtMs,
        runNowAtMs: nextStatus === "active" ? lookup.runNowAtMs : undefined,
        status: nextStatus,
        statusReason:
          nextStatus === "blocked" ? lookup.statusReason : undefined,
        schedule: {
          ...lookup.schedule,
          description: input.schedule ?? lookup.schedule.description,
          timezone,
          kind: recurrence ? "recurring" : "one_off",
          recurrence,
        },
        task: input.task ? { text: input.task } : lookup.task,
        version: lookup.version + 1,
      };

      await createSchedulerStore(context.state).saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}

/** Create a tool that removes a scheduled task from the active Slack destination. */
export function createSlackScheduleDeleteTaskTool(
  context: SchedulerToolContext,
) {
  return tool({
    description:
      "Delete a Junior scheduled task from the active Slack conversation.",
    promptSnippet: "delete one schedule from this Slack destination",
    promptGuidelines: [ACTIVE_TASK_ID_GUIDELINE, ACTIVE_DESTINATION_GUIDELINE],
    inputSchema: Type.Object({
      task_id: Type.String({ minLength: 1 }),
    }),
    execute: async ({ task_id }) => {
      const lookup = await getWritableTask({ context, taskId: task_id });

      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: Date.now(),
        status: "deleted",
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
        version: lookup.version + 1,
      };

      await createSchedulerStore(context.state).saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}

/** Create a tool that marks an existing scheduled task due immediately. */
export function createSlackScheduleRunTaskNowTool(
  context: SchedulerToolContext,
) {
  return tool({
    description:
      "Queue an active Junior scheduled task to run as soon as possible.",
    promptSnippet: "run one active schedule now without changing its cadence",
    promptGuidelines: [
      ACTIVE_TASK_ID_GUIDELINE,
      ACTIVE_DESTINATION_GUIDELINE,
      "Use when the user asks to run an existing scheduled task now; do not rewrite the stored calendar cadence.",
    ],
    inputSchema: Type.Object({
      task_id: Type.String({ minLength: 1 }),
    }),
    execute: async ({ task_id }) => {
      const lookup = await getWritableTask({ context, taskId: task_id });
      if (lookup.status !== "active") {
        throwToolInputError(
          "Scheduled task must be active before it can be run now. Resume the task first if you want it to run.",
        );
      }

      const nowMs = Date.now();
      const next: ScheduledTask = {
        ...lookup,
        updatedAtMs: nowMs,
        runNowAtMs: nowMs,
        version: lookup.version + 1,
      };

      await createSchedulerStore(context.state).saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}
