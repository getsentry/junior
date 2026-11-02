import {
  eventTriggerText,
  type EventTriggerDescription,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { z } from "zod";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import type { StoredEventAutomation } from "@/chat/event-automations/store";
import type { EventAutomation } from "@/chat/event-automations/types";
import {
  eventNamespaceSchema,
  automationEventCatalog,
  describeRegisteredEventTrigger,
  registeredEventTypeSchema,
  registeredEventMatchSchema,
  requireEventIdentifier,
  requireValidEventTrigger,
  type EventCatalog,
} from "@/chat/events/catalog";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { destinationFilterValue } from "@/chat/automations/creator";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

/** Model-facing shape of one event automation. */
export const compactEventAutomationResultSchema = z
  .object({
    type: z.literal("event"),
    id: z.string().min(1),
    status: z.enum(["active", "blocked", "paused", "deleted"]),
    statusReason: z.string().nullable(),
    title: z.string().min(1).nullable(),
    dashboardUrl: z.string().url().nullable(),
    instruction: z.string().min(1),
    trigger: z
      .object({
        namespace: z.string().min(1),
        identifier: z.string().min(1).nullable(),
        resourceType: z.string().min(1).nullable(),
        label: z.string().min(1),
        events: z.array(z.string().min(1)).min(1),
        match: z.record(z.string(), z.unknown()).optional(),
        available: z.boolean(),
        problems: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict(),
    destination: z
      .object({
        id: z.string().min(1),
        channel: z.string().min(1),
        thread: z.string().min(1).nullable(),
      })
      .strict(),
    credentialMode: z.enum(["system", "creator"]),
    isCreator: z.boolean(),
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
    createdBy: z
      .object({
        name: z.string().min(1).nullable(),
        username: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/**
 * Build the validated event trigger accepted by automation tools. A trigger
 * names a namespace, events, and filters. It has no identifier: the filters
 * select the resources.
 */
export function registeredEventAutomationTriggerSchema(catalog: EventCatalog) {
  const plugins = automationEventCatalog(catalog);
  return z
    .object({
      namespace: eventNamespaceSchema(plugins),
      label: z.string().trim().min(1).max(500),
      events: z.array(registeredEventTypeSchema(plugins)).min(1),
      match: registeredEventMatchSchema(),
    })
    .strict();
}

/**
 * Check an event-automation trigger with the enabled plugins and return it
 * as it is saved. Tools and the dashboard send triggers with no identifier.
 * Only a restored version can still have one, because it was saved before
 * identifiers left the write paths. Then it names a resource type too, and
 * the identifier gets its plugin's convention. Events and list values lose
 * repeats.
 */
export function requireEventAutomationTrigger(
  catalog: EventCatalog,
  input: {
    events: readonly string[];
    identifier?: string;
    label: string;
    match?: EventAutomation["trigger"]["match"];
    namespace: string;
    resourceType?: string;
  },
): EventAutomation["trigger"] {
  const { identifier, resourceType } = input;
  if ((identifier === undefined) !== (resourceType === undefined)) {
    throw new ToolInputError(
      "A restored trigger must set both a resource type and an identifier, or neither.",
    );
  }
  const events = [...new Set(input.events)];
  const match = requireValidEventTrigger(
    automationEventCatalog(catalog),
    { namespace: input.namespace, resourceType, events, match: input.match },
    "event_automation",
  );
  return {
    namespace: input.namespace,
    ...(identifier !== undefined && resourceType !== undefined
      ? {
          identifier: requireEventIdentifier(catalog, {
            identifier,
            namespace: input.namespace,
            resourceType,
          }),
          resourceType,
        }
      : undefined),
    label: input.label,
    events,
    ...(match ? { match } : undefined),
  };
}

/**
 * Describe a saved trigger with the enabled plugins. Its problems say why it
 * cannot work: a plugin can remove or rename a resource type, event, or filter
 * after the trigger was saved. Resource types with `automation: false` never
 * dispatch event automations.
 */
export function describeEventAutomationTrigger(
  trigger: EventAutomation["trigger"],
  catalog: EventCatalog,
): EventTriggerDescription {
  return describeRegisteredEventTrigger(
    automationEventCatalog(catalog),
    trigger,
  );
}

/** Project an event automation into the bounded tool-result shape. */
export function compactEventAutomation(
  task: StoredEventAutomation,
  catalog: EventCatalog,
  isCreator: boolean,
) {
  const { problems } = describeEventAutomationTrigger(task.trigger, catalog);
  return compactEventAutomationResultSchema.parse({
    type: "event",
    id: task.id,
    status: task.status,
    statusReason: task.statusReason ?? null,
    title: task.title?.trim() || null,
    dashboardUrl: getDashboardTaskLink(task.id) ?? null,
    instruction: task.task.text,
    trigger: {
      namespace: task.trigger.namespace,
      identifier: task.trigger.identifier ?? null,
      resourceType: task.trigger.resourceType ?? null,
      label: task.trigger.label,
      events: task.trigger.events,
      ...(task.trigger.match ? { match: task.trigger.match } : undefined),
      available: problems.length === 0,
      ...(problems.length > 0 ? { problems } : undefined),
    },
    destination: {
      id: destinationFilterValue(task.destination),
      channel: task.destination.channelId,
      thread: null,
    },
    credentialMode: task.credentialMode,
    isCreator,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination).map(
      (outcome) => ({
        action: outcome.action,
        destination: {
          channel: outcome.destination.channelId,
          thread: outcome.destination.threadTs ?? null,
        },
      }),
    ),
    createdBy: {
      name: task.createdBy.fullName ?? null,
      username: task.createdBy.userName ?? null,
    },
  });
}

/** Return the standard successful event-automation tool result. */
export async function eventAutomationToolResult(
  conversationId: string,
  task: StoredEventAutomation,
  catalog: EventCatalog,
  isCreator: boolean,
) {
  const automation = compactEventAutomation(task, catalog, isCreator);
  const description = describeEventAutomationTrigger(task.trigger, catalog);
  const title =
    automation.title ?? fallbackShortTitle(task.task.text, "Event automation");
  return {
    automation,
    objectCards: await saveObjectAnnotations(conversationId, "junior", [
      {
        kind: "object",
        objectType: "automation",
        label: title,
        key: task.id,
        title,
        url: automation.dashboardUrl,
        description: task.task.text,
        status: description.problems.length === 0 ? "ready" : "unavailable",
        trigger: eventTriggerText(task.trigger.label, description),
        warning:
          description.problems.length > 0
            ? ["Trigger unavailable.", ...description.problems].join(" ")
            : undefined,
      } satisfies ObjectAnnotation,
    ]),
  };
}
