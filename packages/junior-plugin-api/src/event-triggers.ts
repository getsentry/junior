/**
 * The one check for the events and filters that an event automation trigger
 * or a Watch selects.
 *
 * Core runs it before it saves an event automation or creates a Watch, and to
 * find saved triggers that can no longer work. The dashboard runs it in the
 * editor, so all of them use the same rules.
 */
import type { EventMatch, EventMatchFields, PluginEventType } from "./events";

type EventMatchField = EventMatchFields[string];

/** One reason a selection of events and filters cannot work. */
export interface EventTriggerProblem {
  /**
   * - `unknown_resource_type`: the source has no such enabled resource type.
   * - `unknown_event`: the resource type has no such event.
   * - `unknown_field`: the resource type has no such filter. Saved triggers
   *   get this after a plugin renames or removes a filter.
   * - `field_not_set`: a selected event never sets the filter, so the filter
   *   never matches that event.
   * - `invalid_value`: the filter value has the wrong type or is not allowed.
   */
  reason:
    | "unknown_resource_type"
    | "unknown_event"
    | "unknown_field"
    | "field_not_set"
    | "invalid_value";
  /** The filter with the problem. Missing for a resource type or event problem. */
  field?: string;
  /** Plain words for the person or agent who changes the selection. */
  message: string;
}

/** The selection to check: one resource type, its events, and its filters. */
export interface EventTriggerSelection {
  resourceType: string;
  events: readonly string[];
  match?: EventMatch;
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

function valueProblem(
  filter: string,
  field: EventMatchField,
  value: EventMatch[string],
): string | undefined {
  if (Array.isArray(value) && field.kind === "boolean") {
    return `${filter} takes one true or false value, not a list.`;
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== field.kind)) {
    return Array.isArray(value)
      ? `Each ${filter} value must be ${kindWords(field.kind)}.`
      : `${filter} must be ${kindWords(field.kind)}.`;
  }
  const allowed = field.enum;
  const notAllowed = allowed
    ? values.find((entry) => !allowed.includes(String(entry)))
    : undefined;
  if (allowed && notAllowed !== undefined) {
    return `${filter} cannot be "${notAllowed}". Use one of: ${quoted(allowed)}.`;
  }
  return undefined;
}

/**
 * List why a selection cannot work with the resource types of one source. An
 * empty list means the resource type exists, every selected event is
 * supported, and every selected event can match every filter. A filter on a
 * list field (`list: true`) matches when the event list includes the value.
 * Set `inputKeys` for the agent, so messages name the `match.<key>` input.
 */
export function eventTriggerProblems(
  resourceTypes: readonly Pick<
    PluginEventType,
    "type" | "matchFields" | "supportedEvents"
  >[],
  selection: EventTriggerSelection,
  options: { inputKeys?: boolean } = {},
): EventTriggerProblem[] {
  const resourceType = resourceTypes.find(
    (candidate) => candidate.type === selection.resourceType,
  );
  if (!resourceType) {
    return [
      {
        reason: "unknown_resource_type",
        message:
          resourceTypes.length === 0
            ? "The plugin for this source is not enabled."
            : `"${selection.resourceType}" is not an enabled resource type. Use one of: ${quoted(resourceTypes.map((candidate) => candidate.type))}.`,
      },
    ];
  }
  const problems: EventTriggerProblem[] = [];
  const events = selection.events.filter((eventType) =>
    resourceType.supportedEvents.includes(eventType),
  );
  for (const eventType of selection.events) {
    if (events.includes(eventType)) continue;
    problems.push({
      reason: "unknown_event",
      message: `"${eventType}" is not an event for this resource type. Use one of: ${quoted(resourceType.supportedEvents)}.`,
    });
  }
  const fields = resourceType.matchFields ?? {};
  const fieldNames = Object.keys(fields);
  for (const [key, value] of Object.entries(selection.match ?? {})) {
    const filter = options.inputKeys
      ? `Filter "${key}" (match.${key})`
      : `Filter "${key}"`;
    const field = fields[key];
    if (!field) {
      problems.push({
        reason: "unknown_field",
        field: key,
        message:
          fieldNames.length === 0
            ? `${filter} does not exist. This resource type has no filters, so remove it.`
            : `${filter} does not exist for this resource type. Remove it, or use one of: ${quoted(fieldNames)}.`,
      });
      continue;
    }
    const missing = eventsWithoutMatchField(field, events);
    if (missing.length > 0) {
      problems.push({
        reason: "field_not_set",
        field: key,
        message: `${filter} is not set on ${quoted(missing)}, so it never matches those events. Remove the filter or those events.`,
      });
    }
    const invalid = valueProblem(filter, field, value);
    if (invalid) {
      problems.push({ reason: "invalid_value", field: key, message: invalid });
    }
  }
  return problems;
}

/** How people see one Event trigger. Each entry is one line of plain text. */
export interface EventTriggerDescription {
  /** Each selected event in plain words, such as "pull request opened". */
  events: string[];
  /** Each filter in plain words. Every filter must match. */
  filters: string[];
  /** Why the trigger cannot work as saved. Empty when it can. */
  problems: string[];
}

/** Write one event type in plain words: `pull_request.opened` is "pull request opened". */
export function eventTypeText(eventType: string): string {
  return eventType.replaceAll(/[._]/g, " ");
}

/**
 * Write one filter in plain words. A list field (`list: true`) reads
 * "authors includes alice"; other fields read "repo is api or web".
 */
export function eventMatchFilterText(
  key: string,
  field: EventMatchField | undefined,
  value: EventMatch[string],
): string {
  const values = (Array.isArray(value) ? value : [value]).map(String);
  // A list field holds many values, so it "includes" one. Other fields "are" one.
  const verb = field?.list ? "includes" : "is";
  return `${key} ${verb} ${values.join(" or ")}`;
}

/**
 * Describe a selection for the dashboard and Slack, so both show the same
 * words. Pass the resource types of the selection's source, as for
 * `eventTriggerProblems`. Its problems are the messages of that check.
 */
export function describeEventTrigger(
  resourceTypes: readonly Pick<
    PluginEventType,
    "type" | "matchFields" | "supportedEvents"
  >[],
  selection: EventTriggerSelection,
): EventTriggerDescription {
  const fields =
    resourceTypes.find((candidate) => candidate.type === selection.resourceType)
      ?.matchFields ?? {};
  return {
    events: selection.events.map(eventTypeText),
    filters: Object.entries(selection.match ?? {}).map(([key, value]) =>
      eventMatchFilterText(key, fields[key], value),
    ),
    problems: eventTriggerProblems(resourceTypes, selection).map(
      (problem) => problem.message,
    ),
  };
}

/** Join filters into one line. Every filter must match, so join with "and". */
export function eventTriggerFiltersText(filters: readonly string[]): string {
  return filters.join(" and ");
}

/**
 * Write a whole trigger as one line, for cards and lists:
 * "Pull request · pull request opened · filters: isDraft is false".
 */
export function eventTriggerText(
  resource: string,
  description: Pick<EventTriggerDescription, "events" | "filters">,
): string {
  return [
    resource,
    description.events.join(", "),
    ...(description.filters.length > 0
      ? [`filters: ${eventTriggerFiltersText(description.filters)}`]
      : []),
  ].join(" · ");
}
