import {
  agentEventKeys,
  agentEventMatchSchema,
  eventTriggerText,
  type EventMatch,
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
  registeredEventTriggerProblems,
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
    status_reason: z.string().nullable(),
    title: z.string().min(1).nullable(),
    dashboard_url: z.string().url().nullable(),
    instruction: z.string().min(1),
    trigger: z
      .object({
        namespace: z.string().min(1),
        identifier: z.string().min(1).nullable(),
        resource_type: z.string().min(1).nullable(),
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
    credential_mode: z.enum(["system", "creator"]),
    is_creator: z.boolean(),
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
    created_by: z
      .object({
        name: z.string().min(1).nullable(),
        username: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

/** Build the validated event trigger accepted by event-automation tools. */
export function registeredEventAutomationTriggerSchema(catalog: EventCatalog) {
  const plugins = automationEventCatalog(catalog);
  return z
    .object({
      namespace: eventNamespaceSchema(plugins),
      label: z.string().trim().min(1).max(500),
      events: z.array(registeredEventTypeSchema(plugins)).min(1),
      match: registeredEventMatchSchema().describe(
        "Filters that select the events, from the match_fields of the namespace. Use the match of a subscribable tool result to select one resource, such as { repo, pull_request } for one pull request. Leave it out to run for every resource, when the reach of each event allows that. A single value must equal the event data. A list means the event value may be any one entry. For a field with list: true, the event value is a list, and it matches when it includes the value or any entry.",
      ),
    })
    .strict();
}

/**
 * Filter changes of an update. A value sets the filter, and null removes it.
 * A filter that is left out keeps its saved value, so an update cannot make
 * a trigger broader by leaving out a filter.
 */
const eventMatchChangesSchema = z
  .record(
    agentEventMatchSchema.keyType,
    z.union([agentEventMatchSchema.valueType, z.null()]),
  )
  .optional()
  .describe(
    "Filter changes, from the match_fields of the namespace. A value sets the filter, null removes it, and a filter that is left out keeps its saved value. When the namespace changes, the saved filters are dropped.",
  );

/** Build the event trigger that the update tool accepts. */
export function registeredEventAutomationTriggerChangesSchema(
  catalog: EventCatalog,
) {
  return registeredEventAutomationTriggerSchema(catalog).extend({
    match: eventMatchChangesSchema,
  });
}

/**
 * Apply filter changes to the saved trigger, key by key. A change to another
 * namespace starts from no filters.
 */
export function changedEventMatch(
  saved: Pick<EventAutomation["trigger"], "match" | "namespace">,
  namespace: string,
  changes: z.output<typeof eventMatchChangesSchema>,
): EventMatch | undefined {
  const match: EventMatch = {
    ...(namespace === saved.namespace ? saved.match : undefined),
  };
  for (const [key, value] of Object.entries(changes ?? {})) {
    if (value === null) delete match[key];
    else match[key] = value;
  }
  return Object.keys(match).length > 0 ? match : undefined;
}

/**
 * Check a new event-automation trigger with the enabled plugins and return
 * it as it is saved. It names a resource type and an identifier, or neither.
 * The identifier gets its plugin's convention. Events and list values lose
 * repeats.
 */
export function requireEventAutomationTrigger(
  catalog: EventCatalog,
  input: {
    events: readonly string[];
    identifier?: string | null;
    label: string;
    match?: EventAutomation["trigger"]["match"];
    namespace: string;
    resourceType?: string | null;
  },
  options?: { inputKeys: boolean },
): EventAutomation["trigger"] {
  const identifier = input.identifier ?? undefined;
  const resourceType = input.resourceType ?? undefined;
  if ((identifier === undefined) !== (resourceType === undefined)) {
    throw new ToolInputError(
      "Set both resourceType and identifier for one resource, or leave out both to run for every resource.",
    );
  }
  const events = [...new Set(input.events)];
  const match = requireValidEventTrigger(
    automationEventCatalog(catalog),
    { namespace: input.namespace, resourceType, events, match: input.match },
    "event_automation",
    options,
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
  // Name filters as the agent writes them in match.
  const problems = registeredEventTriggerProblems(
    automationEventCatalog(catalog),
    task.trigger,
    { inputKeys: true },
  ).map((problem) => problem.message);
  return compactEventAutomationResultSchema.parse({
    type: "event",
    id: task.id,
    status: task.status,
    status_reason: task.statusReason ?? null,
    title: task.title?.trim() || null,
    dashboard_url: getDashboardTaskLink(task.id) ?? null,
    instruction: task.task.text,
    trigger: {
      namespace: task.trigger.namespace,
      identifier: task.trigger.identifier ?? null,
      resource_type: task.trigger.resourceType ?? null,
      label: task.trigger.label,
      events: task.trigger.events,
      ...(task.trigger.match
        ? { match: agentEventKeys(task.trigger.match) }
        : undefined),
      available: problems.length === 0,
      ...(problems.length > 0 ? { problems } : undefined),
    },
    destination: {
      id: destinationFilterValue(task.destination),
      channel: task.destination.channelId,
      thread: null,
    },
    credential_mode: task.credentialMode,
    is_creator: isCreator,
    outcomes: effectiveTaskOutcomes(task.outcomes, task.destination).map(
      (outcome) => ({
        action: outcome.action,
        destination: {
          channel: outcome.destination.channelId,
          thread: outcome.destination.threadTs ?? null,
        },
      }),
    ),
    created_by: {
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
        url: automation.dashboard_url,
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
