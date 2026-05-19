import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import {
  buildCalendarRecurrence,
  parseScheduleTimestamp,
} from "@/chat/scheduler/cadence";
import { createStateSchedulerStore } from "@/chat/scheduler/store";
import type {
  ScheduledCalendarFrequency,
  ScheduledTask,
  ScheduledTaskDestination,
  ScheduledTaskPrincipal,
  ScheduledTaskRecurrence,
  ScheduledTaskStatus,
} from "@/chat/scheduler/types";
import { normalizeSlackConversationId } from "@/chat/slack/client";
import { tool } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const TASK_ID_PREFIX = "sched";
const MAX_LISTED_TASKS = 50;

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
  if (!context.threadTs) {
    return {
      ok: false,
      error: "No active Slack thread context is available.",
    };
  }

  return {
    ok: true,
    destination: {
      platform: "slack",
      teamId: context.teamId,
      channelId,
      threadTs: context.threadTs,
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
    task.destination.channelId === destination.channelId &&
    (task.destination.threadTs ?? "") === (destination.threadTs ?? "")
  );
}

async function getWritableTask(args: {
  context: ToolRuntimeContext;
  taskId: string;
}): Promise<
  | { ok: true; task: ScheduledTask; destination: ScheduledTaskDestination }
  | { ok: false; error: string }
> {
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
    destination: destination.destination,
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
      error: "Recurring scheduled tasks require next_run_at_iso.",
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

/** Create a tool that stores a scheduled task for the active Slack context. */
export function createSlackScheduleCreateTaskTool(context: ToolRuntimeContext) {
  return tool({
    description:
      "Create a Junior scheduled task for the active Slack destination. The destination is always the current Slack channel/thread context; never accept or invent another destination. Use only after the user asks to schedule future or recurring Junior work. For recurring work, provide an exact next_run_at_iso and a calendar recurrence_frequency.",
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
      timezone: Type.String({ minLength: 1, maxLength: 80 }),
      next_run_at_iso: Type.String({
        minLength: 1,
        description:
          "Exact next run time as an ISO timestamp, computed from the user's requested schedule.",
      }),
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

      const nextRunAtMs = parseScheduleTimestamp(input.next_run_at_iso);
      if (!nextRunAtMs) {
        return {
          ok: false,
          error: "next_run_at_iso must be a valid ISO timestamp.",
        };
      }
      const recurrence = buildRecurrence({
        input,
        nextRunAtMs,
        timezone: input.timezone,
      });
      if (!recurrence.ok) {
        return recurrence;
      }

      const nowMs = Date.now();
      const task: ScheduledTask = {
        id: buildTaskId(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        createdBy: requester.requester,
        destination: destination.destination,
        nextRunAtMs,
        originalRequest: context.userText,
        schedule: {
          description: input.schedule_description,
          timezone: input.timezone,
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
      "List Junior scheduled tasks for the active Slack destination only. Use when the user asks what is scheduled here or wants task IDs before editing/removing schedules.",
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
    description:
      "Edit a Junior scheduled task in the active Slack destination. Use only for task IDs returned from the active destination. Do not move tasks across channels or threads.",
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

      const nextRunAtMs = input.next_run_at_iso
        ? parseScheduleTimestamp(input.next_run_at_iso)
        : lookup.task.nextRunAtMs;
      if (input.next_run_at_iso && !nextRunAtMs) {
        return {
          ok: false,
          error: "next_run_at_iso must be a valid ISO timestamp.",
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
            "Active scheduled tasks require next_run_at_iso when no next run is stored.",
        };
      }
      const timezone = input.timezone ?? lookup.task.schedule.timezone;
      const recurrence = buildRecurrence({
        existing: lookup.task.schedule.recurrence,
        input,
        nextRunAtMs,
        timezone,
      });
      if (!recurrence.ok) {
        return recurrence;
      }

      const next: ScheduledTask = {
        ...lookup.task,
        updatedAtMs: Date.now(),
        nextRunAtMs,
        status: status ?? lookup.task.status,
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
      "Remove a Junior scheduled task from the active Slack destination. Use only for task IDs returned from this destination.",
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
