import type {
  InboxSnoozeTrigger,
  InboxItemPayload,
} from "@sentry/junior/api/schema";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * A snooze choice, such as "Tomorrow morning". A choice with `short`, such
 * as "15m", shows as a cell of the menu's duration grid.
 */
export type SnoozeChoice = {
  label: string;
  short?: string;
  untilMs(nowMs: number): number;
};

/** `hour`:00 in the browser's timezone, `days` after the day of `nowMs`. */
function atLocalHour(nowMs: number, days: number, hour: number) {
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
  {
    label: "15 minutes",
    short: "15m",
    untilMs: (nowMs) => nowMs + 15 * MINUTE_MS,
  },
  {
    label: "30 minutes",
    short: "30m",
    untilMs: (nowMs) => nowMs + 30 * MINUTE_MS,
  },
  { label: "1 hour", short: "1h", untilMs: (nowMs) => nowMs + HOUR_MS },
  { label: "3 hours", short: "3h", untilMs: (nowMs) => nowMs + 3 * HOUR_MS },
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
  /** How each Event reads after the resource's name, where its source says. */
  phrases: Readonly<Record<string, string>>;
  /** The resource type, so a label can leave it out. */
  resourceType: string;
}

/**
 * A custom snooze: it ends at `untilMs`, on any of `triggers`, or on
 * whichever comes first. It has at least one of them, or else
 * `untilClosed`: a Someday snooze, which lasts until the item closes.
 */
export interface CustomSnoozeEnd {
  triggers: InboxSnoozeTrigger[];
  untilClosed?: true;
  untilMs: number | undefined;
}

/** The end of a Someday snooze: no time and no Event. */
export const SOMEDAY: CustomSnoozeEnd = {
  triggers: [],
  untilClosed: true,
  untilMs: undefined,
};

/**
 * Snooze a row until Events on the subject of its items, or on a page that
 * the viewer names, such as another pull request, and maybe a time too.
 */
export interface EventSnooze {
  onSnooze(end: CustomSnoozeEnd): void;
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
  items: readonly InboxItemPayload[],
  onSnooze: ((end: CustomSnoozeEnd) => void) | undefined,
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
      ? {
          events: resource.events,
          phrases: resource.phrases,
          resourceType: resource.resourceType,
        }
      : undefined,
  };
}
