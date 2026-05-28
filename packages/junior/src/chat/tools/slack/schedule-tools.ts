import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  buildCalendarRecurrence,
  parseScheduleTimestamp,
} from "@/chat/scheduler/cadence";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import { SCHEDULED_TASK_SYSTEM_ACTOR } from "@/chat/scheduler/types";
import type {
  ScheduledCalendarFrequency,
  ScheduledTask,
  ScheduledTaskConversationAccess,
  ScheduledTaskCredentialSubject,
  ScheduledTaskDestination,
  ScheduledTaskPrincipal,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from "@/chat/scheduler/types";
import { isDmChannel, normalizeSlackConversationId } from "@/chat/slack/client";
import { isSlackTeamId } from "@/chat/slack/ids";
import { tool } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const TASK_ID_PREFIX = "sched";
const MAX_LISTED_TASKS = 50;
const DEFAULT_SCHEDULE_TIMEZONE = "America/Los_Angeles";
const ACTIVE_DESTINATION_GUIDELINE =
  "Only manage tasks for the active Slack DM or channel; never target an existing thread, another channel, or another user's DM.";
const ACTIVE_TASK_ID_GUIDELINE =
  "Use only task IDs returned from this active destination.";
const RECURRING_GUIDELINE =
  "Set recurring=false for one-time requests like 'in 1 minute', 'tomorrow', or a specific date; set recurring=true only for requests that explicitly repeat.";

const recurrenceInputSchema = Type.Object({
  frequency: Type.Union([
    Type.Literal("daily"),
    Type.Literal("weekly"),
    Type.Literal("monthly"),
    Type.Literal("yearly"),
  ]),
  interval: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        "Calendar interval. For example, 2 with weekly means every two weeks.",
    }),
  ),
  weekdays: Type.Optional(
    Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
      maxItems: 7,
      description:
        "For weekly schedules only. Sunday is 0, Monday is 1, Saturday is 6.",
    }),
  ),
});

function requireActiveDestination(
  context: ToolRuntimeContext,
):
  | { ok: true; destination: ScheduledTaskDestination }
  | { ok: false; error: string } {
  const channelId = normalizeSlackConversationId(context.channelId);
  if (!channelId) {
    return {
      ok: false,
      error: "No active Slack channel context is available.",
    };
  }
  if (!context.teamId) {
    return {
      ok: false,
      error: "No active Slack workspace context is available.",
    };
  }
  if (!isSlackTeamId(context.teamId)) {
    return {
      ok: false,
      error: "Active Slack workspace context is invalid.",
    };
  }

  return {
    ok: true,
    destination: {
      platform: "slack",
      teamId: context.teamId,
      channelId,
    },
  };
}

function requireRequester(
  context: ToolRuntimeContext,
):
  | { ok: true; requester: ScheduledTaskPrincipal }
  | { ok: false; error: string } {
  const userId = context.requester?.userId;
  if (!userId) {
    return {
      ok: false,
      error: "No active Slack requester context is available.",
    };
  }

  return {
    ok: true,
    requester: {
      slackUserId: userId,
      ...(context.requester?.userName
        ? { userName: context.requester.userName }
        : {}),
      ...(context.requester?.fullName
        ? { fullName: context.requester.fullName }
        : {}),
    },
  };
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
  context: ToolRuntimeContext;
  taskId: string;
}): Promise<{ ok: true; task: ScheduledTask } | { ok: false; error: string }> {
  const destination = requireActiveDestination(args.context);
  if (!destination.ok) {
    return destination;
  }

  const task = await createStateSchedulerStore().getTask(args.taskId);
  if (!task || task.status === "deleted") {
    return {
      ok: false,
      error: "Scheduled task was not found in the active destination.",
    };
  }

  if (!sameDestination(task, destination.destination)) {
    return {
      ok: false,
      error:
        "Scheduled task can only be managed from the Slack destination where it was created.",
    };
  }
  return {
    ok: true,
    task,
  };
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
    recurrence?: {
      frequency?: unknown;
      interval?: number;
      weekdays?: number[];
    } | null;
  };
  nextRunAtMs: number | undefined;
  timezone: string;
}):
  | { ok: true; recurrence?: ScheduledTaskRecurrence }
  | { ok: false; error: string } {
  if (args.input.recurrence === null) {
    return { ok: true, recurrence: undefined };
  }

  const frequency =
    normalizeFrequency(args.input.recurrence?.frequency) ??
    args.existing?.frequency;
  if (!frequency) {
    return { ok: true, recurrence: undefined };
  }
  if (!args.nextRunAtMs) {
    return {
      ok: false,
      error: "Recurring scheduled tasks require next_run_at.",
    };
  }

  try {
    return {
      ok: true,
      recurrence: buildCalendarRecurrence({
        frequency,
        interval: args.input.recurrence?.interval ?? args.existing?.interval,
        nextRunAtMs: args.nextRunAtMs,
        timezone: args.timezone,
        weekdays:
          frequency === "weekly"
            ? (args.input.recurrence?.weekdays ?? args.existing?.weekdays)
            : undefined,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof RangeError
          ? "timezone must be a valid IANA time zone."
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

function validateRecurringFrequencyLimit(input: {
  recurrence?: {
    frequency?: unknown;
  } | null;
}): { ok: true } | { ok: false; error: string } {
  if (
    input.recurrence?.frequency !== undefined &&
    !normalizeFrequency(input.recurrence.frequency)
  ) {
    return {
      ok: false,
      error: "Recurring scheduled tasks can run at most once per day.",
    };
  }

  return { ok: true };
}

function validateRecurringIntent(input: {
  recurring?: unknown;
  recurrence?: unknown;
  existingRecurrence?: ScheduledTaskRecurrence;
}): { ok: true } | { ok: false; error: string } {
  if (typeof input.recurring !== "boolean") {
    return {
      ok: false,
      error: "recurring must be true or false.",
    };
  }
  if (
    !input.recurring &&
    input.recurrence !== undefined &&
    input.recurrence !== null
  ) {
    return {
      ok: false,
      error: "One-off scheduled tasks must not include recurrence fields.",
    };
  }
  if (input.recurring && input.recurrence === null) {
    return {
      ok: false,
      error: "Recurring scheduled tasks require recurrence.",
    };
  }
  if (input.recurring && !input.recurrence && !input.existingRecurrence) {
    return {
      ok: false,
      error: "Recurring scheduled tasks require recurrence.",
    };
  }
  return { ok: true };
}

function shouldRebuildRecurrence(input: {
  next_run_at?: string;
  recurring?: unknown;
  recurrence?: unknown;
  timezone?: string;
}): boolean {
  return (
    input.next_run_at !== undefined ||
    input.recurring !== undefined ||
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
export function createSlackScheduleCreateTaskTool(context: ToolRuntimeContext) {
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
      "Provide recurrence only when recurring=true.",
    ],
    inputSchema: Type.Object({
      task: Type.String({ minLength: 1, maxLength: 4000 }),
      schedule: Type.String({ minLength: 1, maxLength: 300 }),
      recurring: Type.Boolean(),
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
      if (!destination.ok) return destination;
      const requester = requireRequester(context);
      if (!requester.ok) return requester;

      const nowMs = Date.now();
      const recurring = validateRecurringIntent(input);
      if (!recurring.ok) {
        return recurring;
      }
      const timezone = input.timezone ?? getDefaultScheduleTimezone();
      const frequencyLimit = validateRecurringFrequencyLimit(input);
      if (!frequencyLimit.ok) {
        return frequencyLimit;
      }
      if (!isValidTimeZone(timezone)) {
        return {
          ok: false,
          error: "timezone must be a valid IANA time zone.",
        };
      }
      const nextRunAtMs = parseNextRunAtMs(input.next_run_at);
      if (!nextRunAtMs) {
        return {
          ok: false,
          error: "Provide next_run_at as a valid ISO timestamp.",
        };
      }
      const recurrence = buildRecurrence({
        input,
        nextRunAtMs,
        timezone,
      });
      if (!recurrence.ok) {
        return recurrence;
      }
      const conversationAccess = getConversationAccess(destination.destination);
      const credentialSubject = getCredentialSubject({
        access: conversationAccess,
        requester: requester.requester,
      });

      const task: ScheduledTask = {
        id: buildTaskId(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: requester.requester,
        conversationAccess,
        ...(credentialSubject ? { credentialSubject } : {}),
        destination: destination.destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs,
        originalRequest: context.userText,
        schedule: {
          description: input.schedule,
          timezone,
          kind: recurrence.recurrence ? "recurring" : "one_off",
          recurrence: recurrence.recurrence,
        },
        status: "active",
        task: {
          text: input.task,
        },
        version: 1,
      };

      await createStateSchedulerStore().saveTask(task);
      return {
        ok: true,
        task: compactTask(task),
      };
    },
  });
}

/** Create a tool that lists scheduled tasks for the active Slack destination. */
export function createSlackScheduleListTasksTool(context: ToolRuntimeContext) {
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
      if (!destination.ok) return destination;

      const tasks = await createStateSchedulerStore().listTasksForTeam(
        destination.destination.teamId,
      );
      const matching = tasks.filter((task) =>
        sameDestination(task, destination.destination),
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
export function createSlackScheduleUpdateTaskTool(context: ToolRuntimeContext) {
  return tool({
    description: "Edit, pause, resume, or reschedule a Junior scheduled task.",
    promptSnippet: "edit/pause/resume one schedule in this Slack destination",
    promptGuidelines: [
      ACTIVE_TASK_ID_GUIDELINE,
      ACTIVE_DESTINATION_GUIDELINE,
      RECURRING_GUIDELINE,
      "Do not move scheduled tasks across conversations.",
      "Provide next_run_at as an exact ISO timestamp when changing the next run.",
      "Set status to active, paused, or blocked when the user asks to resume, pause, or block a task.",
    ],
    inputSchema: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      task: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      schedule: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      recurring: Type.Optional(Type.Boolean()),
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
      if (!lookup.ok) return lookup;

      const timezone = input.timezone ?? lookup.task.schedule.timezone;
      const frequencyLimit = validateRecurringFrequencyLimit(input);
      if (!frequencyLimit.ok) {
        return frequencyLimit;
      }
      if (!isValidTimeZone(timezone)) {
        return {
          ok: false,
          error: "timezone must be a valid IANA time zone.",
        };
      }
      const parsedNextRunAtMs = parseNextRunAtMs(input.next_run_at);
      const nextRunAtMs = input.next_run_at
        ? parsedNextRunAtMs
        : lookup.task.nextRunAtMs;
      if (input.next_run_at && !nextRunAtMs) {
        return {
          ok: false,
          error: "Provide next_run_at as a valid ISO timestamp.",
        };
      }

      const status = normalizeStatus(input.status);
      if (input.status && !status) {
        return {
          ok: false,
          error: "status must be active, paused, or blocked.",
        };
      }
      if (status === "active" && !nextRunAtMs) {
        return {
          ok: false,
          error:
            "Active scheduled tasks require next_run_at when no next run is stored.",
        };
      }
      const recurringInput =
        input.recurring ??
        (shouldRebuildRecurrence(input)
          ? lookup.task.schedule.kind === "recurring"
          : undefined);
      const recurring =
        typeof recurringInput === "boolean"
          ? validateRecurringIntent({
              ...input,
              existingRecurrence: lookup.task.schedule.recurrence,
              recurring: recurringInput,
            })
          : { ok: true as const };
      if (!recurring.ok) {
        return recurring;
      }
      const recurrence = shouldRebuildRecurrence(input)
        ? buildRecurrence({
            existing:
              recurringInput === false
                ? undefined
                : lookup.task.schedule.recurrence,
            input:
              recurringInput === false ? { ...input, recurrence: null } : input,
            nextRunAtMs,
            timezone,
          })
        : { ok: true as const, recurrence: lookup.task.schedule.recurrence };
      if (!recurrence.ok) {
        return recurrence;
      }
      const nextStatus = status ?? lookup.task.status;

      const next: ScheduledTask = {
        ...lookup.task,
        updatedAtMs: Date.now(),
        nextRunAtMs,
        runNowAtMs:
          nextStatus === "active" ? lookup.task.runNowAtMs : undefined,
        status: nextStatus,
        statusReason:
          nextStatus === "blocked" ? lookup.task.statusReason : undefined,
        schedule: {
          ...lookup.task.schedule,
          description: input.schedule ?? lookup.task.schedule.description,
          timezone,
          kind: recurrence.recurrence ? "recurring" : "one_off",
          recurrence: recurrence.recurrence,
        },
        task: input.task ? { text: input.task } : lookup.task.task,
        version: lookup.task.version + 1,
      };

      await createStateSchedulerStore().saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}

/** Create a tool that removes a scheduled task from the active Slack destination. */
export function createSlackScheduleDeleteTaskTool(context: ToolRuntimeContext) {
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
      if (!lookup.ok) return lookup;

      const next: ScheduledTask = {
        ...lookup.task,
        updatedAtMs: Date.now(),
        status: "deleted",
        nextRunAtMs: undefined,
        runNowAtMs: undefined,
        version: lookup.task.version + 1,
      };

      await createStateSchedulerStore().saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}

/** Create a tool that marks an existing scheduled task due immediately. */
export function createSlackScheduleRunTaskNowTool(context: ToolRuntimeContext) {
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
      if (!lookup.ok) return lookup;
      if (lookup.task.status !== "active") {
        return {
          ok: false,
          error:
            "Scheduled task must be active before it can be run now. Resume the task first if you want it to run.",
        };
      }

      const nowMs = Date.now();
      const next: ScheduledTask = {
        ...lookup.task,
        updatedAtMs: nowMs,
        runNowAtMs: nowMs,
        version: lookup.task.version + 1,
      };

      await createStateSchedulerStore().saveTask(next);
      return {
        ok: true,
        task: compactTask(next),
      };
    },
  });
}
