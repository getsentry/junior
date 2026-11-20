import type {
  InboxSnoozeTrigger,
  ReviewItemPayload,
} from "@sentry/junior/api/schema";

const HOUR_MS = 60 * 60 * 1000;

/** A snooze choice, such as "Tomorrow morning". */
export type SnoozeChoice = { label: string; untilMs(nowMs: number): number };

/** `hour`:00 in the browser's timezone, `days` after the day of `nowMs`. */
export function atLocalHour(nowMs: number, days: number, hour: number) {
  const date = new Date(nowMs);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

/** Days from the day of `nowMs` to the next Monday, 1 to 7. */
function daysToMonday(nowMs: number): number {
  return (8 - new Date(nowMs).getDay()) % 7 || 7;
}

/**
 * The snooze choices, in menu order. A choice with `beforeHour` shows only
 * before that local hour, so it is not a few minutes away.
 */
const snoozeChoices: readonly (SnoozeChoice & { beforeHour?: number })[] = [
  { label: "1 hour", untilMs: (nowMs) => nowMs + HOUR_MS },
  { label: "3 hours", untilMs: (nowMs) => nowMs + 3 * HOUR_MS },
  {
    beforeHour: 13,
    label: "This afternoon",
    untilMs: (nowMs) => atLocalHour(nowMs, 0, 14),
  },
  {
    beforeHour: 17,
    label: "This evening",
    untilMs: (nowMs) => atLocalHour(nowMs, 0, 18),
  },
  {
    label: "Tomorrow morning",
    untilMs: (nowMs) => atLocalHour(nowMs, 1, 9),
  },
  {
    label: "Next week",
    untilMs: (nowMs) => atLocalHour(nowMs, daysToMonday(nowMs), 9),
  },
];

/** The snooze choices that the menu shows at `nowMs`, in order. */
export function snoozeChoicesAt(nowMs: number): SnoozeChoice[] {
  const hour = new Date(nowMs).getHours();
  return snoozeChoices.filter(
    (choice) => choice.beforeHour === undefined || hour < choice.beforeHour,
  );
}

/**
 * The Events that can end a snooze of a row's items: those of the resource
 * type that each item's subject names, such as a pull request.
 */
interface SnoozeEvents {
  /** Event types, in the order that their source lists them. */
  events: readonly string[];
  /** The resource type, so a label can leave it out. */
  resourceType: string;
  /** The viewer can dismiss each item, so an Event can dismiss them. */
  resolve: boolean;
}

/** Snooze a row until an Event on the subject of its items. */
export interface EventSnooze {
  choices: SnoozeEvents;
  onSnooze(trigger: InboxSnoozeTrigger): void;
}

/**
 * The Event snooze of these items. Each item's subject must name a
 * resource of the same type, as the server aims the Event at each item's
 * own resource. Undefined when one does not, or the row cannot snooze.
 */
export function eventSnoozeOf(
  items: readonly ReviewItemPayload[],
  onSnooze: ((trigger: InboxSnoozeTrigger) => void) | undefined,
): EventSnooze | undefined {
  const resource = items[0]?.subject?.resource;
  if (
    !onSnooze ||
    !resource ||
    items.some(
      (item) =>
        item.subject?.resource?.namespace !== resource.namespace ||
        item.subject.resource.resourceType !== resource.resourceType,
    )
  ) {
    return undefined;
  }
  return {
    choices: {
      events: resource.events,
      resourceType: resource.resourceType,
      resolve: items.every((item) => item.canAct),
    },
    onSnooze,
  };
}
