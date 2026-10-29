/**
 * The one check for an Event trigger: its events and its filters.
 *
 * Core runs it before it saves an event automation or a Watch. The dashboard
 * runs it in the editor, so both use the same rules.
 */
import type { EventMatch, EventMatchFields, PluginEventType } from "./events";

type EventMatchField = EventMatchFields[string];

/** One reason a trigger cannot work as saved. */
export interface EventTriggerProblem {
  /**
   * - `unknown_resource_type`: no enabled plugin has the resource type.
   * - `unknown_event`: the resource type has no such event.
   * - `unknown_field`: the resource type has no such filter. Saved triggers
   *   get this after a plugin renames or removes a filter.
   * - `field_not_set`: a selected event never sets the filter, so the trigger
   *   never runs on that event.
   * - `invalid_value`: the filter value has the wrong type or is not allowed.
   */
  reason:
    | "unknown_resource_type"
    | "unknown_event"
    | "unknown_field"
    | "field_not_set"
    | "invalid_value";
  /** The filter with the problem. Missing for an event problem. */
  field?: string;
  /** Plain words for the person or agent who saves the trigger. */
  message: string;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function kindWords(kind: EventMatchField["kind"]): string {
  if (kind === "boolean") return "true or false";
  if (kind === "number") return "a number";
  return "text";
}

/** Return the selected events that never set one filter field. */
export function eventsWithoutMatchField(
  field: Pick<EventMatchField, "events">,
  events: readonly string[],
): string[] {
  const setBy = field.events;
  if (!setBy) return [];
  return events.filter((eventType) => !setBy.includes(eventType));
}

function valueProblems(
  key: string,
  field: EventMatchField,
  value: EventMatch[string],
): EventTriggerProblem[] {
  const invalid = (message: string): EventTriggerProblem[] => [
    { reason: "invalid_value", field: key, message },
  ];
  if (Array.isArray(value) && field.kind === "boolean") {
    return invalid(`"${key}" takes one true or false value, not a list.`);
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== field.kind)) {
    return invalid(
      Array.isArray(value)
        ? `Each "${key}" value must be ${kindWords(field.kind)}.`
        : `"${key}" must be ${kindWords(field.kind)}.`,
    );
  }
  const allowed = field.enum;
  const notAllowed = allowed
    ? values.find((entry) => !allowed.includes(String(entry)))
    : undefined;
  if (allowed && notAllowed !== undefined) {
    return invalid(
      `"${key}" cannot be "${notAllowed}". Use one of: ${quoted(allowed)}.`,
    );
  }
  return [];
}

/**
 * List why a trigger cannot work for one resource type. An empty list means
 * every selected event is supported and can match every filter. A filter on a
 * list field (`list: true`) matches when the event list includes the value.
 */
export function eventTriggerProblems(
  resourceType: Pick<PluginEventType, "matchFields" | "supportedEvents">,
  trigger: { events: readonly string[]; match?: EventMatch },
): EventTriggerProblem[] {
  const problems: EventTriggerProblem[] = [];
  const events = trigger.events.filter((eventType) =>
    resourceType.supportedEvents.includes(eventType),
  );
  for (const eventType of trigger.events) {
    if (events.includes(eventType)) continue;
    problems.push({
      reason: "unknown_event",
      message: `"${eventType}" is not an event for this resource type. Use one of: ${quoted(resourceType.supportedEvents)}.`,
    });
  }
  const fields = resourceType.matchFields ?? {};
  const fieldNames = Object.keys(fields);
  for (const [key, value] of Object.entries(trigger.match ?? {})) {
    const field = fields[key];
    if (!field) {
      problems.push({
        reason: "unknown_field",
        field: key,
        message:
          fieldNames.length === 0
            ? `This resource type has no filters. Remove "${key}".`
            : `"${key}" is not a filter for this resource type. Remove it, or use one of: ${quoted(fieldNames)}.`,
      });
      continue;
    }
    const missing = eventsWithoutMatchField(field, events);
    if (missing.length > 0) {
      problems.push({
        reason: "field_not_set",
        field: key,
        message: `"${key}" is not set on ${quoted(missing)}, so the trigger never runs on those events. Remove the filter or those events.`,
      });
    }
    problems.push(...valueProblems(key, field, value));
  }
  return problems;
}
