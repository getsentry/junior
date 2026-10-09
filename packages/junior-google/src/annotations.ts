import type { ObjectAnnotation } from "@sentry/junior-plugin-api";

/**
 * Build the Conversation annotation for an event on Junior's own calendar.
 *
 * Calendar events have no native object type, so they use `item` with a
 * "Calendar event" display type. The label is the event time, because the time
 * is what people look for first.
 */
export function calendarEventAnnotation(input: {
  eventId: string;
  title?: string;
  label: string;
  url?: string;
  description?: string;
  sourceUpdatedAt?: string;
}): ObjectAnnotation | undefined {
  // Annotation keys are not shortened. Skip events with ids that do not fit.
  if (input.eventId.length > 256) return undefined;
  const description = input.description?.trim();
  return {
    kind: "object",
    key: input.eventId,
    label: input.label,
    objectType: "item",
    displayType: "Calendar event",
    title: (input.title?.trim() || "Untitled event").slice(0, 512),
    url: input.url ?? null,
    ...(description && { description: description.slice(0, 4000) }),
    ...(input.sourceUpdatedAt && { sourceUpdatedAt: input.sourceUpdatedAt }),
  };
}
