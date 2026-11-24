import type { InboxSnoozeWake } from "@sentry/junior/api/schema";

import { eventLabel } from "../eventLabel";

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

/**
 * Why a snooze woke, as its item shows it: the condition that fired, such
 * as "Woke: getsentry/junior#12 is merged".
 */
export function wakeReasonText(wake: InboxSnoozeWake): string {
  if (wake.kind === "time") return "Woke: snooze time reached";
  // An Event type starts with its resource type, such as `pull_request`.
  const resourceType = wake.eventType.split(".")[0] ?? wake.eventType;
  return `Woke: ${eventClause(wake.eventType, wake.phrase, resourceType, wake.resource)}`;
}
