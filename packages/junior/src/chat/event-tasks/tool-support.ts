import { z } from "zod";
import { getDb } from "@/chat/db";
import { getEventTask } from "@/chat/event-tasks/store";
import {
  EVENT_TASK_IDENTIFIER_MAX_LENGTH,
  eventTaskPrincipalSchema,
  type EventTask,
} from "@/chat/event-tasks/types";
import {
  eventNamespaceSchema,
  pluginResourceEventCatalog,
  pluginSupportsEvent,
  registeredEventTypeSchema,
  registeredResourceEventMatchSchema,
  registeredResourceTypeSchema,
  requireSupportedResourceEventMatch,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const compactEventTaskResultSchema = z
  .object({
    id: z.string().min(1),
    task: z.string().min(1),
    namespace: z.string().min(1),
    identifier: z.string().min(1),
    resourceType: z.string().min(1),
    label: z.string().min(1),
    events: z.array(z.string().min(1)).min(1),
    match: z.record(z.string(), z.unknown()).optional(),
    credentialMode: z.enum(["system", "creator"]),
    createdBy: eventTaskPrincipalSchema,
    triggerAvailable: z.boolean(),
  })
  .strict();

/** Validate one successful event-task mutation result. */
export const eventTaskToolResultSchema = juniorToolOutputSchema
  .extend({
    task: compactEventTaskResultSchema,
  })
  .strict();

/** Validate one successful event-task list result. */
export const eventTaskListToolResultSchema = juniorToolOutputSchema
  .extend({
    tasks: z.array(compactEventTaskResultSchema),
    truncated: z.boolean(),
  })
  .strict();

/** Build the validated resource-event trigger accepted by event-task tools. */
export function registeredEventTaskTriggerSchema(
  catalog: ResourceEventCatalog,
) {
  const plugins = pluginResourceEventCatalog(catalog);
  return z
    .object({
      namespace: eventNamespaceSchema(plugins),
      identifier: z
        .string()
        .trim()
        .min(1)
        .max(EVENT_TASK_IDENTIFIER_MAX_LENGTH),
      resourceType: registeredResourceTypeSchema(plugins),
      label: z.string().trim().min(1).max(500),
      events: z.array(registeredEventTypeSchema(plugins)).min(1),
      match: registeredResourceEventMatchSchema(),
    })
    .strict();
}

/** Reject an event-task trigger that is no longer supported by the catalog. */
export function requireSupportedEventTaskTrigger(
  catalog: ResourceEventCatalog,
  trigger: {
    events: string[];
    match?: EventTask["trigger"]["match"];
    namespace: string;
    resourceType: string;
  },
): EventTask["trigger"]["match"] | undefined {
  const plugins = pluginResourceEventCatalog(catalog);
  for (const eventType of trigger.events) {
    if (
      !pluginSupportsEvent(
        plugins,
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
  return requireSupportedResourceEventMatch(plugins, {
    match: trigger.match,
    namespace: trigger.namespace,
    resourceType: trigger.resourceType,
  });
}

/** Require the active Slack authority used for event-task management. */
export function requireEventTaskSlackContext(context: ToolRuntimeContext) {
  if (
    context.source.kind !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack" ||
    context.actor.teamId !== context.source.teamId
  ) {
    throw new ToolInputError(
      "Event tasks require an active Slack channel or DM and actor.",
    );
  }
  return {
    actor: context.actor,
    destination: {
      platform: "slack" as const,
      teamId: context.source.teamId,
      channelId: context.source.channelId,
    },
    source: context.source,
  };
}

/** Return whether an event task belongs to the active Slack destination. */
export function eventTaskMatchesDestination(
  task: EventTask,
  destination: { channelId: string; teamId: string },
): boolean {
  return (
    task.destination.teamId === destination.teamId &&
    task.destination.channelId === destination.channelId
  );
}

/** Load one task only when it belongs to this Slack channel or DM. */
export async function writableEventTask(
  context: ToolRuntimeContext,
  id: string,
): Promise<EventTask> {
  const { destination } = requireEventTaskSlackContext(context);
  const task = await getEventTask(getDb(), id);
  if (!task || !eventTaskMatchesDestination(task, destination)) {
    throw new ToolInputError(
      "Event task was not found in this Slack channel or DM.",
    );
  }
  return task;
}

export function eventTaskTriggerAvailable(
  task: EventTask,
  catalog: ResourceEventCatalog,
): boolean {
  // resourceType is presentation metadata; runtime matching uses namespace,
  // identifier, and event type. Core snapshot events never dispatch tasks.
  const registration =
    pluginResourceEventCatalog(catalog)[task.trigger.namespace];
  return Boolean(
    registration &&
    task.trigger.events.every((eventType) =>
      registration.resourceTypes.some((resourceType) =>
        resourceType.supportedEvents.includes(eventType),
      ),
    ),
  );
}

/** Project an event task into the bounded tool-result shape. */
export function compactEventTask(
  task: EventTask,
  catalog: ResourceEventCatalog,
) {
  return compactEventTaskResultSchema.parse({
    id: task.id,
    task: task.task.text,
    namespace: task.trigger.namespace,
    identifier: task.trigger.identifier,
    resourceType: task.trigger.resourceType,
    label: task.trigger.label,
    events: task.trigger.events,
    ...(task.trigger.match ? { match: task.trigger.match } : undefined),
    credentialMode: task.credentialMode,
    createdBy: task.createdBy,
    triggerAvailable: eventTaskTriggerAvailable(task, catalog),
  });
}

/** Return the standard successful event-task tool result. */
export function eventTaskSuccess(
  task: EventTask,
  catalog: ResourceEventCatalog,
) {
  return {
    task: compactEventTask(task, catalog),
  };
}
