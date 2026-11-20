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

/** The Events of a resource that can end a snooze, such as a pull request. */
export interface SnoozeEvents {
  /** Event types, in the order that their source lists them. */
  events: readonly string[];
  /** The resource type, so a label can leave it out. */
  resourceType: string;
}

/**
 * Snooze a row until an Event on the subject of its items, or on a page
 * that the viewer names, such as another pull request.
 */
export interface EventSnooze {
  onSnooze(trigger: InboxSnoozeTrigger): void;
  /** The viewer can dismiss each item, so an Event can dismiss them. */
  resolve: boolean;
  /**
   * The Events of each item's subject. Unset when an item's subject names
   * no resource, or one of another type, as the server aims the Event at
   * each item's own resource.
   */
  subject: SnoozeEvents | undefined;
}

/** The Event snooze of these items. Undefined when the row cannot snooze. */
export function eventSnoozeOf(
  items: readonly ReviewItemPayload[],
  onSnooze: ((trigger: InboxSnoozeTrigger) => void) | undefined,
): EventSnooze | undefined {
  if (!onSnooze || items.length === 0) return undefined;
  const resource = items[0]?.subject?.resource;
  const shared =
    resource &&
    items.every(
      (item) =>
        item.subject?.resource?.namespace === resource.namespace &&
        item.subject.resource.resourceType === resource.resourceType,
    );
  return {
    onSnooze,
    resolve: items.every((item) => item.canAct),
    subject: shared
      ? { events: resource.events, resourceType: resource.resourceType }
      : undefined,
  };
}
