import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  buildCalendarRecurrence,
  parseRelativeScheduleTimestamp,
  parseScheduleTimestamp,
} from "@/chat/scheduler/cadence";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import { SCHEDULED_TASK_SYSTEM_ACTOR } from "@/chat/scheduler/types";
import type {
  ScheduledCalendarFrequency,
  ScheduledTask,
  ScheduledTaskDestination,
  ScheduledTaskPrincipal,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from "@/chat/scheduler/types";
import { normalizeSlackConversationId } from "@/chat/slack/client";
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
    title: task.task.title,
    objective: task.task.objective,
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
    recurrence_frequency?: unknown;
    recurrence_interval?: number;
    recurrence_weekdays?: number[];
  };
  nextRunAtMs: number | undefined;
  timezone: string;
}):
  | { ok: true; recurrence?: ScheduledTaskRecurrence }
  | { ok: false; error: string } {
  if (args.input.recurrence_frequency === null) {
    return { ok: true, recurrence: undefined };
  }

  const frequency =
    normalizeFrequency(args.input.recurrence_frequency) ??
    args.existing?.frequency;
  if (!frequency) {
    return { ok: true, recurrence: undefined };
  }
  if (!args.nextRunAtMs) {
    return {
      ok: false,
      error:
        "Recurring scheduled tasks require next_run_at_iso or next_run_at_text.",
    };
  }

  try {
    return {
      ok: true,
      recurrence: buildCalendarRecurrence({
        frequency,
        interval: args.input.recurrence_interval ?? args.existing?.interval,
        nextRunAtMs: args.nextRunAtMs,
        timezone: args.timezone,
        weekdays:
          frequency === "weekly"
            ? (args.input.recurrence_weekdays ?? args.existing?.weekdays)
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
  recurrence_frequency?: unknown;
}): { ok: true } | { ok: false; error: string } {
  if (
    input.recurrence_frequency !== undefined &&
    input.recurrence_frequency !== null &&
    !normalizeFrequency(input.recurrence_frequency)
  ) {
    return {
      ok: false,
      error: "Recurring scheduled tasks can run at most once per day.",
    };
  }

  return { ok: true };
}

function shouldRebuildRecurrence(input: {
  next_run_at_text?: string;
  next_run_at_iso?: string;
  recurrence_frequency?: unknown;
  recurrence_interval?: number;
  recurrence_weekdays?: number[];
  timezone?: string;
}): boolean {
  return (
    input.next_run_at_text !== undefined ||
    input.next_run_at_iso !== undefined ||
    input.recurrence_frequency !== undefined ||
    input.recurrence_interval !== undefined ||
    input.recurrence_weekdays !== undefined ||
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

function parseNextRunAtMs(args: {
  input: {
    next_run_at_iso?: string;
    next_run_at_text?: string;
  };
  nowMs: number;
  timezone: string;
}): number | undefined {
  try {
    if (args.input.next_run_at_iso) {
      return parseScheduleTimestamp(args.input.next_run_at_iso);
    }
    if (args.input.next_run_at_text) {
      return parseRelativeScheduleTimestamp({
        nowMs: args.nowMs,
        text: args.input.next_run_at_text,
        timezone: args.timezone,
      });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function hasConflictingNextRunInputs(input: {
  next_run_at_iso?: string;
  next_run_at_text?: string;
}): boolean {
  return Boolean(input.next_run_at_iso && input.next_run_at_text);
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
      "When the user's scheduling intent is clear, create the task immediately without asking for confirmation.",
      "Ask for confirmation only when the task contract, schedule, or active destination is ambiguous.",
      "Recurring tasks can run at most once per day; use only daily, weekly, monthly, or yearly recurrence frequencies.",
      "Provide exactly one of next_run_at_iso or next_run_at_text; omit timezone to use the configured default.",
      "Use recurrence_frequency only for recurring schedules.",
    ],
    inputSchema: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 120 }),
      objective: Type.String({ minLength: 1, maxLength: 1000 }),
      instructions: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        minItems: 1,
        maxItems: 12,
      }),
      expected_output: Type.Optional(
        Type.String({ minLength: 1, maxLength: 1000 }),
      ),
      schedule_description: Type.String({ minLength: 1, maxLength: 300 }),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      next_run_at_iso: Type.Optional(
        Type.String({
          minLength: 1,
          description:
            "Exact next run time as an ISO timestamp, computed from the user's requested schedule.",
        }),
      ),
      next_run_at_text: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 120,
          description:
            'Supported relative one-off text such as "tomorrow at 9am" in the supplied timezone.',
        }),
      ),
      recurrence_frequency: Type.Optional(
        Type.Union(
          [
            Type.Literal("daily"),
            Type.Literal("weekly"),
            Type.Literal("monthly"),
            Type.Literal("yearly"),
          ],
          {
            description:
              "Calendar recurrence for recurring tasks. Omit for exact one-off calendar dates.",
          },
        ),
      ),
      recurrence_interval: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 100,
          description:
            "Calendar interval. For example, 2 with weekly means every two weeks.",
        }),
      ),
      recurrence_weekdays: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), {
          maxItems: 7,
          description:
            "For weekly schedules only. Sunday is 0, Monday is 1, Saturday is 6.",
        }),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          maxItems: 12,
        }),
      ),
      source_context: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          maxItems: 12,
        }),
      ),
    }),
    execute: async (input) => {
      const destination = requireActiveDestination(context);
      if (!destination.ok) return destination;
      const requester = requireRequester(context);
      if (!requester.ok) return requester;

      const nowMs = Date.now();
      const timezone = input.timezone ?? getDefaultScheduleTimezone();
      if (hasConflictingNextRunInputs(input)) {
        return {
          ok: false,
          error: "Provide only one of next_run_at_iso or next_run_at_text.",
        };
      }
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
      const nextRunAtMs = parseNextRunAtMs({
        input,
        nowMs,
        timezone,
      });
      if (!nextRunAtMs) {
        return {
          ok: false,
          error:
            'Provide next_run_at_iso as a valid ISO timestamp or next_run_at_text such as "tomorrow at 9am".',
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

      const task: ScheduledTask = {
        id: buildTaskId(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: requester.requester,
        destination: destination.destination,
        executionActor: SCHEDULED_TASK_SYSTEM_ACTOR,
        nextRunAtMs,
        originalRequest: context.userText,
        schedule: {
          description: input.schedule_description,
          timezone,
          kind: recurrence.recurrence ? "recurring" : "one_off",
          recurrence: recurrence.recurrence,
        },
        status: "active",
        task: {
          title: input.title,
          objective: input.objective,
          instructions: input.instructions,
          expectedOutput: input.expected_output,
          constraints: input.constraints,
          sourceContext: input.source_context,
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
      "Do not move scheduled tasks across conversations.",
      "Provide exactly one of next_run_at_iso or next_run_at_text when changing the next run.",
      "Set status to active, paused, or blocked when the user asks to resume, pause, or block a task.",
    ],
    inputSchema: Type.Object({
      task_id: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      instructions: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          minItems: 1,
          maxItems: 12,
        }),
      ),
      expected_output: Type.Optional(
        Type.String({ minLength: 1, maxLength: 1000 }),
      ),
      schedule_description: Type.Optional(
        Type.String({ minLength: 1, maxLength: 300 }),
      ),
      timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
      next_run_at_iso: Type.Optional(Type.String({ minLength: 1 })),
      next_run_at_text: Type.Optional(
        Type.String({ minLength: 1, maxLength: 120 }),
      ),
      recurrence_frequency: Type.Optional(
        Type.Union([
          Type.Literal("daily"),
          Type.Literal("weekly"),
          Type.Literal("monthly"),
          Type.Literal("yearly"),
          Type.Null(),
        ]),
      ),
      recurrence_interval: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100 }),
      ),
      recurrence_weekdays: Type.Optional(
        Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { maxItems: 7 }),
      ),
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("paused"),
          Type.Literal("blocked"),
        ]),
      ),
      constraints: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          maxItems: 12,
        }),
      ),
      source_context: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
          maxItems: 12,
        }),
      ),
    }),
    execute: async (input) => {
      const lookup = await getWritableTask({
        context,
        taskId: input.task_id,
      });
      if (!lookup.ok) return lookup;

      const timezone = input.timezone ?? lookup.task.schedule.timezone;
      if (hasConflictingNextRunInputs(input)) {
        return {
          ok: false,
          error: "Provide only one of next_run_at_iso or next_run_at_text.",
        };
      }
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
      const parsedNextRunAtMs = parseNextRunAtMs({
        input,
        nowMs: Date.now(),
        timezone,
      });
      const nextRunAtMs =
        input.next_run_at_iso || input.next_run_at_text
          ? parsedNextRunAtMs
          : lookup.task.nextRunAtMs;
      if ((input.next_run_at_iso || input.next_run_at_text) && !nextRunAtMs) {
        return {
          ok: false,
          error:
            'Provide next_run_at_iso as a valid ISO timestamp or next_run_at_text such as "tomorrow at 9am".',
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
            "Active scheduled tasks require next_run_at_iso or next_run_at_text when no next run is stored.",
        };
      }
      const recurrence = shouldRebuildRecurrence(input)
        ? buildRecurrence({
            existing: lookup.task.schedule.recurrence,
            input,
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
          description:
            input.schedule_description ?? lookup.task.schedule.description,
          timezone,
          kind: recurrence.recurrence ? "recurring" : "one_off",
          recurrence: recurrence.recurrence,
        },
        task: {
          ...lookup.task.task,
          title: input.title ?? lookup.task.task.title,
          objective: input.objective ?? lookup.task.task.objective,
          instructions: input.instructions ?? lookup.task.task.instructions,
          expectedOutput:
            input.expected_output ?? lookup.task.task.expectedOutput,
          constraints: input.constraints ?? lookup.task.task.constraints,
          sourceContext: input.source_context ?? lookup.task.task.sourceContext,
        },
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
