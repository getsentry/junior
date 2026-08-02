import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb } from "@/chat/db";
import {
  createEventTask,
  getEventTask,
  listEventTasksForTeam,
  saveActiveEventTask,
} from "@/chat/event-tasks/store";
import {
  eventTaskPrincipalSchema,
  type EventTask,
  type EventTaskConversationAccess,
  type EventTaskPrincipal,
} from "@/chat/event-tasks/types";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import type { ToolRegistry } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import {
  eventNamespaceSchema,
  normalizeEventIdentifier,
  pluginSupportsEvent,
  registeredEventTypeSchema,
  registeredResourceTypeSchema,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";

const MAX_LISTED_TASKS = 50;

const compactEventTaskResultSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["active", "deleted"]),
    task: z.string().min(1),
    namespace: z.string().min(1),
    identifier: z.string().min(1),
    resourceType: z.string().min(1),
    label: z.string().min(1),
    events: z.array(z.string().min(1)).min(1),
    credentialMode: z.enum(["system", "creator"]),
    createdBy: eventTaskPrincipalSchema,
    triggerAvailable: z.boolean(),
  })
  .strict();

const eventTaskResultDataSchema = z
  .object({ task: compactEventTaskResultSchema })
  .strict();

const eventTaskToolResultSchema = juniorToolResultSchema
  .extend({
    ok: z.literal(true),
    status: z.literal("success"),
    data: eventTaskResultDataSchema,
    task: compactEventTaskResultSchema,
  })
  .strict();

const eventTaskListResultDataSchema = z
  .object({
    tasks: z.array(compactEventTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();

const eventTaskListToolResultSchema = juniorToolResultSchema
  .extend({
    ok: z.literal(true),
    status: z.literal("success"),
    data: eventTaskListResultDataSchema,
    tasks: z.array(compactEventTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();

function triggerSchema(catalog: ResourceEventCatalog) {
  return z
    .object({
      namespace: eventNamespaceSchema(catalog),
      identifier: z.string().trim().min(1),
      resourceType: registeredResourceTypeSchema(catalog),
      label: z.string().trim().min(1).max(500),
      events: z.array(registeredEventTypeSchema(catalog)).min(1),
    })
    .strict()
    .superRefine((trigger, context) => {
      trigger.events.forEach((eventType, index) => {
        if (
          !pluginSupportsEvent(
            catalog,
            trigger.namespace,
            trigger.resourceType,
            eventType,
          )
        ) {
          context.addIssue({
            code: "custom",
            message: `Resource type "${trigger.namespace}:${trigger.resourceType}" does not support event "${eventType}".`,
            path: ["events", index],
          });
        }
      });
    });
}

function requireSupportedTrigger(
  catalog: ResourceEventCatalog,
  trigger: { events: string[]; namespace: string; resourceType: string },
): void {
  for (const eventType of trigger.events) {
    if (
      !pluginSupportsEvent(
        catalog,
        trigger.namespace,
        trigger.resourceType,
        eventType,
      )
    ) {
      throw new ToolInputError(
        `Resource type "${trigger.namespace}:${trigger.resourceType}" does not support event "${eventType}".`,
      );
    }
  }
}

/** Require the active Slack authority used for event-task management. */
function requireSlackContext(context: ToolRuntimeContext) {
  if (
    context.source.platform !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack" ||
    context.actor.teamId !== context.destination.teamId
  ) {
    throw new ToolInputError(
      "Event tasks require an active Slack channel or DM and actor.",
    );
  }
  return {
    actor: context.actor,
    destination: context.destination,
    source: context.source,
  };
}

function principal(
  actor: Extract<
    NonNullable<ToolRuntimeContext["actor"]>,
    { platform: "slack" }
  >,
): EventTaskPrincipal {
  return {
    slackUserId: actor.userId,
    ...(actor.fullName ? { fullName: actor.fullName } : {}),
    ...(actor.userName ? { userName: actor.userName } : {}),
  };
}

/** Capture the durable access classification of the active Slack destination. */
function conversationAccess(
  channelId: string,
  sourceVisibility: "private" | "public",
): EventTaskConversationAccess {
  if (channelId.startsWith("D")) {
    return { audience: "direct", visibility: "private" };
  }
  if (channelId.startsWith("G")) {
    return { audience: "group", visibility: "private" };
  }
  return {
    audience: "channel",
    visibility: sourceVisibility,
  };
}

function sameDestination(
  task: EventTask,
  destination: { channelId: string; teamId: string },
): boolean {
  return (
    task.destination.teamId === destination.teamId &&
    task.destination.channelId === destination.channelId
  );
}

/** Load one active task only when it belongs to this Slack channel or DM. */
async function writableTask(
  context: ToolRuntimeContext,
  id: string,
): Promise<EventTask> {
  const { destination } = requireSlackContext(context);
  const task = await getEventTask(getDb(), id);
  if (
    !task ||
    task.status === "deleted" ||
    !sameDestination(task, destination)
  ) {
    throw new ToolInputError(
      "Event task was not found in this Slack channel or DM.",
    );
  }
  return task;
}

/** Build a retry-stable task id scoped to actor, destination, and tool call. */
function buildTaskId(args: {
  channelId: string;
  teamId: string;
  toolCallId: string | undefined;
  userId: string;
}): string {
  const toolCallId = args.toolCallId?.trim();
  if (!toolCallId) {
    throw new Error("Event task creation requires a tool-call identity.");
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actor: args.userId,
        channel: args.channelId,
        operation: toolCallId,
        team: args.teamId,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `evt_${digest}`;
}

function cleanEvents(events: string[]): string[] {
  const clean = [
    ...new Set(events.map((event) => event.trim()).filter(Boolean)),
  ];
  if (clean.length === 0) {
    throw new ToolInputError("At least one event is required.");
  }
  return clean;
}

/** Return whether an edit changes the task's executable event source. */
function changesTriggerMatch(
  current: EventTask["trigger"],
  next: EventTask["trigger"],
): boolean {
  const currentEvents = [...current.events].sort();
  const nextEvents = [...next.events].sort();
  return (
    current.namespace !== next.namespace ||
    current.identifier !== next.identifier ||
    currentEvents.length !== nextEvents.length ||
    currentEvents.some((event, index) => event !== nextEvents[index])
  );
}

function triggerAvailable(
  task: EventTask,
  catalog: ResourceEventCatalog,
): boolean {
  return task.trigger.events.every((eventType) =>
    pluginSupportsEvent(
      catalog,
      task.trigger.namespace,
      task.trigger.resourceType,
      eventType,
    ),
  );
}

function compactTask(task: EventTask, catalog: ResourceEventCatalog) {
  return compactEventTaskResultSchema.parse({
    id: task.id,
    status: task.status,
    task: task.task.text,
    namespace: task.trigger.namespace,
    identifier: task.trigger.identifier,
    resourceType: task.trigger.resourceType,
    label: task.trigger.label,
    events: task.trigger.events,
    credentialMode: task.credentialMode,
    createdBy: task.createdBy,
    triggerAvailable: triggerAvailable(task, catalog),
  });
}

function success(task: EventTask, catalog: ResourceEventCatalog) {
  const details = { task: compactTask(task, catalog) };
  return {
    ok: true as const,
    status: "success" as const,
    data: details,
    ...details,
  };
}

/** Create the core tool that stores an event task. */
export function createEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  const trigger = triggerSchema(catalog);
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Create a durable event task that executes the supplied instruction for every matching resource event. Use for whenever-this-happens-do-X automation; ordinary watch, notify, or tell-me-when requests use watchResourceEvents instead. The task remains active for this Slack channel or DM until deleted and may use the creator's connected credentials. Prefer a subscribable tool result when available.",
    inputSchema: z
      .object({
        task: z.string().trim().min(1).max(4000),
        trigger,
        credentialMode: z
          .enum(["creator", "system"])
          .describe(
            "Use creator to make the task creator's connected credentials available, or system when the creator says not to use them. Omit for the creator default.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        task: string;
        trigger: z.input<typeof trigger>;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, ...prepared } = input;
      return credentialMode === "system"
        ? { ...prepared, credentialMode }
        : prepared;
    },
    outputSchema: eventTaskToolResultSchema,
    async execute(input, options) {
      const { actor, destination, source } = requireSlackContext(context);
      requireSupportedTrigger(catalog, input.trigger);
      const id = buildTaskId({
        channelId: destination.channelId,
        teamId: destination.teamId,
        toolCallId: options.toolCallId,
        userId: actor.userId,
      });
      const db = getDb();
      const existing = await getEventTask(db, id);
      if (existing) {
        if (
          !sameDestination(existing, destination) ||
          existing.createdBy.slackUserId !== actor.userId
        ) {
          throw new ToolInputError("Event task operation identity is invalid.");
        }
        if (existing.status === "deleted") {
          throw new ToolInputError("Event task was already deleted.");
        }
        return success(existing, catalog);
      }
      const nowMs = Date.now();
      const task: EventTask = {
        id,
        conversationAccess: conversationAccess(
          destination.channelId,
          source.visibility,
        ),
        createdAtMs: nowMs,
        createdBy: principal(actor),
        credentialMode: input.credentialMode ?? "creator",
        destination,
        status: "active",
        task: { text: input.task },
        trigger: {
          namespace: input.trigger.namespace,
          identifier: normalizeEventIdentifier(
            catalog,
            input.trigger.namespace,
            input.trigger.identifier,
          ),
          resourceType: input.trigger.resourceType,
          label: input.trigger.label,
          events: cleanEvents(input.trigger.events),
        },
      };
      return success(await createEventTask(db, task), catalog);
    },
  });
}

/** Create the core tool that lists event tasks for this destination. */
export function createListEventTasksTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    description:
      "List event tasks for this Slack channel or DM, including tasks created from other threads in the same destination. A false triggerAvailable value means the task remains stored but its plugin event is not currently enabled.",
    inputSchema: z.object({}).strict(),
    outputSchema: eventTaskListToolResultSchema,
    async execute() {
      const { destination } = requireSlackContext(context);
      const matching = (
        await listEventTasksForTeam(getDb(), destination.teamId)
      ).filter((task) => sameDestination(task, destination));
      const tasks = matching
        .slice(0, MAX_LISTED_TASKS)
        .map((task) => compactTask(task, catalog));
      const details = {
        tasks,
        truncated: matching.length > tasks.length,
      };
      return {
        ok: true as const,
        status: "success" as const,
        data: details,
        ...details,
      };
    },
  });
}

/** Create the core tool that updates an event task in this destination. */
export function createUpdateEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Update the instruction, registered trigger, or credential use for an event task in this Slack channel or DM. Event tasks created from other threads in the same destination are manageable here.",
    inputSchema: z
      .object({
        taskId: z.string().min(1),
        task: z.string().trim().min(1).max(4000).optional(),
        trigger: triggerSchema(catalog).optional(),
        credentialMode: z
          .enum(["system", "creator"])
          .describe(
            "Set creator to make the task's original creator credentials available, or system to disable them. Creator always means the task's createdBy actor, never the current requester. Only that original creator may enable creator mode. Omit to leave unchanged.",
          )
          .optional(),
      })
      .strict(),
    prepareArguments(args) {
      const input = args as {
        taskId: string;
        task?: string;
        trigger?: z.input<ReturnType<typeof triggerSchema>>;
        credentialMode?: "creator" | "system" | null;
      };
      const { credentialMode, ...prepared } = input;
      return credentialMode ? { ...prepared, credentialMode } : prepared;
    },
    outputSchema: eventTaskToolResultSchema,
    async execute(input) {
      const current = await writableTask(context, input.taskId);
      if (input.trigger) {
        requireSupportedTrigger(catalog, input.trigger);
      }
      const { actor } = requireSlackContext(context);
      const isCreator = actor.userId === current.createdBy.slackUserId;
      if (input.credentialMode === "creator" && !isCreator) {
        throw new ToolInputError(
          "Only the event task creator can enable creator credential use.",
        );
      }
      if (
        input.task === undefined &&
        input.trigger === undefined &&
        input.credentialMode == null
      ) {
        throw new ToolInputError("Event task update requires a change.");
      }
      const nextTrigger = input.trigger
        ? {
            namespace: input.trigger.namespace,
            identifier: normalizeEventIdentifier(
              catalog,
              input.trigger.namespace,
              input.trigger.identifier,
            ),
            resourceType: input.trigger.resourceType,
            label: input.trigger.label,
            events: cleanEvents(input.trigger.events),
          }
        : current.trigger;
      const changesExecution =
        (input.task !== undefined && input.task !== current.task.text) ||
        changesTriggerMatch(current.trigger, nextTrigger);
      const next: EventTask = {
        ...current,
        credentialMode:
          changesExecution && !isCreator
            ? "system"
            : (input.credentialMode ?? current.credentialMode),
        task: input.task ? { text: input.task } : current.task,
        trigger: nextTrigger,
      };
      const saved = await saveActiveEventTask(getDb(), next);
      if (!saved) {
        throw new ToolInputError("Event task is no longer active.");
      }
      return success(saved, catalog);
    },
  });
}

/** Create the core tool that deletes an event task in this destination. */
export function createDeleteEventTaskTool(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
) {
  return zodTool({
    approvalMode: "review",
    annotations: {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
    executionMode: "sequential",
    description:
      "Delete an event task from this Slack channel or DM, including a task created from another thread in the same destination.",
    inputSchema: z.object({ taskId: z.string().min(1) }).strict(),
    outputSchema: eventTaskToolResultSchema,
    async execute({ taskId }) {
      const current = await writableTask(context, taskId);
      const next: EventTask = {
        ...current,
        status: "deleted",
      };
      const deleted = await saveActiveEventTask(getDb(), next);
      if (!deleted) {
        throw new ToolInputError(
          "Event task was not found in this Slack channel or DM.",
        );
      }
      return success(deleted, catalog);
    },
  });
}

/** Build event task tools for an interactive Slack actor. */
export function createEventTaskTools(
  context: ToolRuntimeContext,
  catalog: ResourceEventCatalog,
): ToolRegistry {
  if (
    context.source.platform !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack"
  ) {
    return {};
  }
  const canCreate = Object.keys(catalog).length > 0;
  return {
    ...(canCreate
      ? { createEventTask: createEventTaskTool(context, catalog) }
      : {}),
    listEventTasks: createListEventTasksTool(context, catalog),
    updateEventTask: createUpdateEventTaskTool(context, catalog),
    deleteEventTask: createDeleteEventTaskTool(context, catalog),
  };
}
