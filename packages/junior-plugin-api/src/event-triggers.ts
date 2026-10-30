/**
 * The one check for the events and filters that an event automation trigger
 * or a Watch selects.
 *
 * Core runs it before it saves an event automation or creates a Watch, and to
 * find saved triggers that can no longer work. The dashboard runs it in the
 * editor, so all of them use the same rules.
 */
import {
  anyResourceMatchFields,
  type EventMatch,
  type EventMatchFields,
  type PluginEvents,
  type PluginEventType,
} from "./events";

type EventMatchField = EventMatchFields[string];

/** One reason a selection of events and filters cannot work. */
export interface EventTriggerProblem {
  /**
   * - `unknown_resource_type`: the source has no such enabled resource type.
   * - `unknown_event`: the resource type has no such event.
   * - `identifier_required`: a trigger with no identifier selects an event
   *   that cannot run for every resource.
   * - `filter_required`: a trigger with no identifier selects an event that
   *   needs a filter, and the trigger does not set it.
   * - `unknown_field`: the resource type has no such filter. Saved triggers
   *   get this after a plugin renames or removes a filter.
   * - `field_not_set`: a selected event never sets the filter, so the filter
   *   never matches that event.
   * - `invalid_value`: the filter value has the wrong type or is not allowed.
   */
  reason:
    | "unknown_resource_type"
    | "unknown_event"
    | "identifier_required"
    | "filter_required"
    | "unknown_field"
    | "field_not_set"
    | "invalid_value";
  /** The filter with the problem. Missing for a resource type or event problem. */
  field?: string;
  /** Plain words for the person or agent who changes the selection. */
  message: string;
}

/**
 * The selection to check: one resource type, its events, and its filters.
 * Leave out the resource type for a trigger with no identifier. It runs for
 * every resource of the source that its filters match.
 */
export interface EventTriggerSelection {
  resourceType?: string;
  events: readonly string[];
  match?: EventMatch;
}

/** The enabled resource types of one source, and the events that can run for any resource. */
export interface EventTriggerSource {
  resourceTypes: readonly Pick<
    PluginEventType,
    "type" | "matchFields" | "supportedEvents"
  >[];
  anyResourceEvents?: PluginEvents["anyResourceEvents"];
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

/** The events and filters that one selection can use. */
function selectionScope(
  source: EventTriggerSource,
  selection: Pick<EventTriggerSelection, "resourceType">,
):
  | {
      events: readonly string[];
      fields: EventMatchFields;
      owner: "resource type" | "source";
    }
  | EventTriggerProblem {
  if (selection.resourceType === undefined) {
    const events = Object.keys(source.anyResourceEvents ?? {});
    if (events.length === 0) {
      return {
        reason: "identifier_required",
        message:
          "This source cannot run for every resource. Set a resource type and an identifier.",
      };
    }
    return {
      events,
      fields: anyResourceMatchFields(source.resourceTypes),
      owner: "source",
    };
  }
  const resourceType = source.resourceTypes.find(
    (candidate) => candidate.type === selection.resourceType,
  );
  if (!resourceType) {
    return {
      reason: "unknown_resource_type",
      message: `"${selection.resourceType}" is not an enabled resource type. Use one of: ${quoted(source.resourceTypes.map((candidate) => candidate.type))}.`,
    };
  }
  return {
    events: resourceType.supportedEvents,
    fields: resourceType.matchFields ?? {},
    owner: "resource type",
  };
}

/**
 * Return the events and filters that a selection can use: those of its
 * resource type, or with no resource type, the source's `anyResourceEvents`
 * with the filters of every resource type. Return nothing when the source
 * has no such resource type or cannot run for every resource.
 */
export function eventTriggerChoices(
  source: EventTriggerSource,
  selection: Pick<EventTriggerSelection, "resourceType">,
): { events: readonly string[]; fields: EventMatchFields } | undefined {
  if (source.resourceTypes.length === 0) return undefined;
  const scope = selectionScope(source, selection);
  return "reason" in scope
    ? undefined
    : { events: scope.events, fields: scope.fields };
}

/**
 * List why a selection cannot work with the resource types of one source. An
 * empty list means the resource type exists, every selected event is
 * supported, and every selected event can match every filter. A filter on a
 * list field (`list: true`) matches when the event list includes the value.
 * A selection with no resource type can use only the source's
 * `anyResourceEvents`, with the filters of every resource type, and must set
 * each filter that those events require.
 * Set `inputKeys` for the agent, so messages name the `match.<key>` input.
 */
export function eventTriggerProblems(
  source: EventTriggerSource,
  selection: EventTriggerSelection,
  options: { inputKeys?: boolean } = {},
): EventTriggerProblem[] {
  if (source.resourceTypes.length === 0) {
    return [
      {
        reason: "unknown_resource_type",
        message: "The plugin for this source is not enabled.",
      },
    ];
  }
  const scope = selectionScope(source, selection);
  if ("reason" in scope) return [scope];
  const filterName = (key: string) =>
    options.inputKeys ? `Filter "${key}" (match.${key})` : `Filter "${key}"`;
  const problems: EventTriggerProblem[] = [];
  const events = selection.events.filter((eventType) =>
    scope.events.includes(eventType),
  );
  for (const eventType of selection.events) {
    if (events.includes(eventType)) continue;
    const anySupports = source.resourceTypes.some((resourceType) =>
      resourceType.supportedEvents.includes(eventType),
    );
    problems.push(
      selection.resourceType === undefined && anySupports
        ? {
            reason: "identifier_required",
            message: `"${eventType}" cannot run for every resource. Set a resource type and an identifier, or use one of: ${quoted(scope.events)}.`,
          }
        : {
            reason: "unknown_event",
            message: `"${eventType}" is not an event for this ${scope.owner}. Use one of: ${quoted(scope.events)}.`,
          },
    );
  }
  const fieldNames = Object.keys(scope.fields);
  for (const [key, value] of Object.entries(selection.match ?? {})) {
    const filter = filterName(key);
    const field = scope.fields[key];
    if (!field) {
      problems.push({
        reason: "unknown_field",
        field: key,
        message:
          fieldNames.length === 0
            ? `${filter} does not exist. This ${scope.owner} has no filters, so remove it.`
            : `${filter} does not exist for this ${scope.owner}. Remove it, or use one of: ${quoted(fieldNames)}.`,
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
  if (selection.resourceType === undefined) {
    problems.push(
      ...requiredFilterProblems(source, events, selection, options),
    );
  }
  return problems;
}

/** Name each filter that the selected events need and the trigger does not set. */
function requiredFilterProblems(
  source: EventTriggerSource,
  events: readonly string[],
  selection: EventTriggerSelection,
  options: { inputKeys?: boolean },
): EventTriggerProblem[] {
  const missing = new Map<string, string[]>();
  for (const eventType of events) {
    const filter = source.anyResourceEvents?.[eventType]?.requiredFilter;
    if (filter === undefined || selection.match?.[filter] !== undefined) {
      continue;
    }
    missing.set(filter, [...(missing.get(filter) ?? []), eventType]);
  }
  return [...missing].map(([filter, requiredBy]) => ({
    reason: "filter_required",
    field: filter,
    message: `This trigger needs a "${filter}" filter${options.inputKeys ? ` (match.${filter})` : ""}, because ${quoted(requiredBy)} cannot run for every resource.`,
  }));
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
 * words. Pass the selection's source, as for `eventTriggerProblems`. Its
 * problems are the messages of that check.
 */
export function describeEventTrigger(
  source: EventTriggerSource,
  selection: EventTriggerSelection,
): EventTriggerDescription {
  const fields = eventTriggerChoices(source, selection)?.fields ?? {};
  return {
    events: selection.events.map(eventTypeText),
    filters: Object.entries(selection.match ?? {}).map(([key, value]) =>
      eventMatchFilterText(key, fields[key], value),
    ),
    problems: eventTriggerProblems(source, selection).map(
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
