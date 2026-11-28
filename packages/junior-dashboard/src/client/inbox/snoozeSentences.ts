import type {
  InboxSnoozeWake,
  InboxViewerSnooze,
} from "@sentry/junior/api/schema";

import { eventLabel } from "../eventLabel";
import { formatRelativeTime, formatTime } from "../time";

/** Capitalize the first letter, such as a label at a sentence's start. */
export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An Event as a clause about the page that `name` names, such as
 * "getsentry/junior#12 is merged", from the phrase of the Event's source.
 * An Event without one reads as its label on the page, such as "checks
 * passed on getsentry/junior#12".
 */
function eventClause(
  eventType: string,
  phrase: string | undefined,
  resourceType: string,
  name: string,
): string {
  return phrase
    ? `${name} ${phrase}`
    : `${eventLabel(eventType, resourceType)} on ${name}`;
}

/**
 * A snooze condition as a sentence, such as "When getsentry/junior#12 is
 * merged".
 */
export function eventSentence(
  eventType: string,
  events: {
    phrases: Readonly<Record<string, string>>;
    resourceType: string;
  },
  name: string,
): string {
  const phrase = events.phrases[eventType];
  const clause = eventClause(eventType, phrase, events.resourceType, name);
  return phrase ? `When ${clause}` : sentenceCase(clause);
}

// An Event type starts with its resource type, such as `pull_request`.
function resourceTypeOf(eventType: string): string {
  return eventType.split(".")[0] ?? eventType;
}

/** "14:00" today, else "Tue, Dec 9, 09:00", in the browser's timezone. */
function wakeTime(wakeAtMs: number, nowMs: number): string {
  const sameDay =
    new Date(wakeAtMs).toDateString() === new Date(nowMs).toDateString();
  return formatTime(wakeAtMs, {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    ...(sameDay
      ? undefined
      : { day: "numeric", month: "short", weekday: "short" }),
  });
}

/**
 * What ends the viewer's snooze, and when they snoozed, as its Snoozed row
 * says it, such as "Until Tue, Dec 9, 09:00 or getsentry/junior#12 is
 * merged · snoozed 2 hours ago". A `resolve` Event closes the item.
 */
export function snoozeText(
  snooze: InboxViewerSnooze,
  nowMs = Date.now(),
): string {
  const events = snooze.events ?? [];
  const clauses = (outcome: "resolve" | "wake") =>
    events
      .filter((event) => event.outcome === outcome)
      .map((event) =>
        eventClause(
          event.eventType,
          event.phrase,
          resourceTypeOf(event.eventType),
          event.resource,
        ),
      );
  const wakes = [
    ...(snooze.wakeAt ? [wakeTime(Date.parse(snooze.wakeAt), nowMs)] : []),
    ...clauses("wake"),
  ];
  const closes = clauses("resolve");
  return sentenceCase(
    [
      ...(snooze.untilClosed ? ["until it closes"] : []),
      ...(wakes.length > 0 ? [`until ${wakes.join(" or ")}`] : []),
      ...(closes.length > 0 ? [`closes when ${closes.join(" or ")}`] : []),
      `snoozed ${formatRelativeTime(snooze.snoozedAt)}`,
    ].join(" · "),
  );
}

/**
 * Why a snooze woke, as its item shows it: the condition that fired, such
 * as "Woke: getsentry/junior#12 is merged".
 */
export function wakeReasonText(wake: InboxSnoozeWake): string {
  if (wake.kind === "time") return "Woke: snooze time reached";
  return `Woke: ${eventClause(wake.eventType, wake.phrase, resourceTypeOf(wake.eventType), wake.resource)}`;
}
