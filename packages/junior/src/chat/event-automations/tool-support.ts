import {
  eventTriggerText,
  ownedObjectAnnotationSchema,
  type EventTriggerDescription,
  type ObjectAnnotation,
} from "@sentry/junior-plugin-api";
import { saveObjectAnnotations } from "@/chat/conversations/annotation-results";
import { z } from "zod";
import { fallbackShortTitle } from "@/chat/services/short-title";
import { getDashboardTaskLink } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import {
  getEventAutomation,
  type StoredEventAutomation,
} from "@/chat/event-automations/store";
import {
  EVENT_AUTOMATION_IDENTIFIER_MAX_LENGTH,
  type EventAutomation,
} from "@/chat/event-automations/types";
import {
  eventNamespaceSchema,
  automationEventCatalog,
  describeRegisteredEventTrigger,
  registeredEventTypeSchema,
  registeredEventMatchSchema,
  registeredResourceTypeSchema,
  requireValidEventTrigger,
  type EventCatalog,
} from "@/chat/events/catalog";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { effectiveTaskOutcomes } from "@/chat/task-outcomes";

const compactEventAutomationResultSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["active", "blocked", "paused", "deleted"]),
    statusReason: z.string().nullable(),
    title: z.string().min(1).nullable(),
    dashboardUrl: z.string().url().nullable(),
    instruction: z.string().min(1),
    trigger: z
      .object({
        namespace: z.string().min(1),
        identifier: z.string().min(1),
        resourceType: z.string().min(1),
        label: z.string().min(1),
        events: z.array(z.string().min(1)).min(1),
        match: z.record(z.string(), z.unknown()).optional(),
        available: z.boolean(),
        problems: z.array(z.string().min(1)).min(1).optional(),
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

/** Validate one successful event-automation mutation result. */
export const eventAutomationToolResultSchema = juniorToolOutputSchema
  .extend({
    automation: compactEventAutomationResultSchema,
    objectCards: z.array(ownedObjectAnnotationSchema),
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
  const plugins = automationEventCatalog(catalog);
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

/** Reject an event-automation trigger that cannot work with the enabled plugins. */
export function requireSupportedEventAutomationTrigger(
  catalog: EventCatalog,
  trigger: {
    events: string[];
    match?: EventAutomation["trigger"]["match"];
    namespace: string;
    resourceType: string;
  },
): EventAutomation["trigger"]["match"] | undefined {
  return requireValidEventTrigger(
    automationEventCatalog(catalog),
    trigger,
    "event_automation",
  );
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
): Promise<StoredEventAutomation> {
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
  requesterSlackUserId?: string,
) {
  const { problems } = describeEventAutomationTrigger(task.trigger, catalog);
  return compactEventAutomationResultSchema.parse({
    id: task.id,
    status: task.status,
    statusReason: task.statusReason ?? null,
    title: task.title?.trim() || null,
    dashboardUrl: getDashboardTaskLink(task.id) ?? null,
    instruction: task.task.text,
    trigger: {
      namespace: task.trigger.namespace,
      identifier: task.trigger.identifier,
      resourceType: task.trigger.resourceType,
      label: task.trigger.label,
      events: task.trigger.events,
      ...(task.trigger.match ? { match: task.trigger.match } : undefined),
      available: problems.length === 0,
      ...(problems.length > 0 ? { problems } : undefined),
    },
    credentialMode: task.credentialMode,
    isCreator: task.createdBy.slackUserId === requesterSlackUserId,
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
  requesterSlackUserId: string,
) {
  const automation = compactEventAutomation(
    task,
    catalog,
    requesterSlackUserId,
  );
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
