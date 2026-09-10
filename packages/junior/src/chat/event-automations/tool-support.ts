import { taskOutcomeSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { getEventAutomation } from "@/chat/event-automations/store";
import {
  EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH,
  eventAutomationPrincipalSchema,
  type EventAutomation,
} from "@/chat/event-automations/types";
import {
  eventNamespaceSchema,
  pluginEventCatalog,
  pluginSupportsEvent,
  registeredEventTypeSchema,
  registeredEventMatchSchema,
  registeredResourceTypeSchema,
  requireSupportedEventMatch,
  type EventCatalog,
} from "@/chat/events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const compactEventAutomationResultSchema = z
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
    outcomes: z.array(taskOutcomeSchema).max(5),
    createdBy: eventAutomationPrincipalSchema,
    triggerAvailable: z.boolean(),
  })
  .strict();

/** Validate one successful event-automation mutation result. */
export const eventAutomationToolResultSchema = juniorToolOutputSchema
  .extend({
    task: compactEventAutomationResultSchema,
  })
  .strict();

/** Validate one successful event-automation list result. */
export const eventAutomationListToolResultSchema = juniorToolOutputSchema
  .extend({
    automations: z.array(compactEventAutomationResultSchema),
    truncated: z.boolean(),
  })
  .strict();

/** Build the validated event trigger accepted by event-automation tools. */
export function registeredEventAutomationTriggerSchema(catalog: EventCatalog) {
  const plugins = pluginEventCatalog(catalog);
  return z
    .object({
      namespace: eventNamespaceSchema(plugins),
      identifier: z
        .string()
        .trim()
        .min(1)
        .max(EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH),
      resourceType: registeredResourceTypeSchema(plugins),
      label: z.string().trim().min(1).max(500),
      events: z.array(registeredEventTypeSchema(plugins)).min(1),
      match: registeredEventMatchSchema(),
    })
    .strict();
}

/** Reject an event-automation trigger that is no longer supported by the catalog. */
export function requireSupportedEventAutomationTrigger(
  catalog: EventCatalog,
  trigger: {
    events: string[];
    match?: EventAutomation["trigger"]["match"];
    namespace: string;
    resourceType: string;
  },
): EventAutomation["trigger"]["match"] | undefined {
  const plugins = pluginEventCatalog(catalog);
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
  return requireSupportedEventMatch(plugins, {
    match: trigger.match,
    namespace: trigger.namespace,
    resourceType: trigger.resourceType,
  });
}

/** Require the active Slack authority used for event-automation management. */
export function requireEventAutomationSlackContext(
  context: ToolRuntimeContext,
) {
  if (
    context.source.kind !== "slack" ||
    context.destination.platform !== "slack" ||
    context.actor?.platform !== "slack" ||
    context.actor.teamId !== context.source.teamId
  ) {
    throw new ToolInputError(
      "Event automations require an active Slack channel or DM and actor.",
    );
  }
  return {
    actor: context.actor,
    destination: {
      platform: "slack" as const,
      teamId: context.source.teamId,
      channelId: context.source.channelId,
      threadTs: context.source.threadTs ?? context.source.messageTs,
    },
    source: context.source,
  };
}

/** Return whether an event automation belongs to the active Slack destination. */
export function eventAutomationMatchesDestination(
  task: EventAutomation,
  destination: { channelId: string; teamId: string },
): boolean {
  return (
    task.destination.teamId === destination.teamId &&
    task.destination.channelId === destination.channelId
  );
}

/**
 * Return whether the active destination may update or delete this automation.
 * Same-destination automations stay local. Public automations may be managed by id from
 * another destination in the same workspace.
 */
export function eventAutomationIsWritableFrom(
  task: EventAutomation,
  destination: { channelId: string; teamId: string },
): boolean {
  if (task.destination.teamId !== destination.teamId) {
    return false;
  }
  return (
    task.destination.channelId === destination.channelId ||
    task.destinationVisibility === "public"
  );
}

/** Load one automation the active destination may update or delete. */
export async function writableEventAutomation(
  context: ToolRuntimeContext,
  id: string,
): Promise<EventAutomation> {
  const { destination } = requireEventAutomationSlackContext(context);
  const task = await getEventAutomation(getDb(), id);
  if (
    !task ||
    task.status === "deleted" ||
    !eventAutomationIsWritableFrom(task, destination)
  ) {
    throw new ToolInputError("Event automation was not found.");
  }
  return task;
}

export function eventAutomationTriggerAvailable(
  task: EventAutomation,
  catalog: EventCatalog,
): boolean {
  // resourceType is presentation metadata; runtime matching uses namespace,
  // identifier, and event type. Core snapshot events never dispatch tasks.
  const registration = pluginEventCatalog(catalog)[task.trigger.namespace];
  return Boolean(
    registration &&
    task.trigger.events.every((eventType) =>
      registration.resourceTypes.some((resourceType) =>
        resourceType.supportedEvents.includes(eventType),
      ),
    ),
  );
}

/** Project an event automation into the bounded tool-result shape. */
export function compactEventAutomation(
  task: EventAutomation,
  catalog: EventCatalog,
) {
  return compactEventAutomationResultSchema.parse({
    id: task.id,
    task: task.task.text,
    namespace: task.trigger.namespace,
    identifier: task.trigger.identifier,
    resourceType: task.trigger.resourceType,
    label: task.trigger.label,
    events: task.trigger.events,
    ...(task.trigger.match ? { match: task.trigger.match } : undefined),
    credentialMode: task.credentialMode,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination),
    createdBy: task.createdBy,
    triggerAvailable: eventAutomationTriggerAvailable(task, catalog),
  });
}

/** Return the standard successful event-automation tool result. */
export function eventAutomationSuccess(
  task: EventAutomation,
  catalog: EventCatalog,
) {
  return {
    task: compactEventAutomation(task, catalog),
  };
}
