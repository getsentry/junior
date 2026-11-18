import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useReducer } from "react";

import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import type { InboxBundle } from "./reviewItemFormat";

const STORAGE_KEY = "junior:inbox:snoozed";
const HOUR_MS = 60 * 60 * 1000;
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One snoozed item, by its id: until when. */
type Snooze = { untilMs: number };

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

function useStoredSnoozes() {
  return useLocalStorage<Record<string, Snooze>>(STORAGE_KEY, {});
}

/** Render again when the next snooze ends, so its row wakes on time. */
function useWakeAtNextEnd(snoozes: Record<string, Snooze>, nowMs: number) {
  const [, wakeUp] = useReducer((count: number) => count + 1, 0);
  const nextWakeMs = Math.min(
    ...Object.values(snoozes)
      .map((snooze) => snooze.untilMs)
      .filter((untilMs) => untilMs > nowMs),
  );
  useEffect(() => {
    if (!Number.isFinite(nextWakeMs)) return;
    const timer = setTimeout(
      wakeUp,
      Math.min(MAX_TIMER_MS, Math.max(0, nextWakeMs - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [nextWakeMs]);
}

/**
 * The items that sleep now, sorted, so the server can count the snoozed
 * items that are still open.
 */
export function useSnoozedItemIds(): string[] {
  const [snoozes] = useStoredSnoozes();
  const nowMs = Date.now();
  useWakeAtNextEnd(snoozes, nowMs);
  return Object.entries(snoozes)
    .filter(([, snooze]) => snooze.untilMs > nowMs)
    .map(([id]) => id)
    .sort();
}

/**
 * Snooze Inbox items in this browser, each by its id. A row snoozes its
 * item, and a stack's Snooze all snoozes each of its items until the same
 * time. Each item wakes at its time. An item that arrives later is not
 * snoozed, so it shows by itself while the rest stay in Snoozed. The
 * server has no snooze, so other browsers do not see it; the nav count
 * names the snoozed items to the server (`useSnoozedItemIds`).
 */
export function useInboxSnoozes(nowMs: number) {
  const [snoozes, setSnoozes] = useStoredSnoozes();
  useWakeAtNextEnd(snoozes, nowMs);
  /** True while the item sleeps. */
  const sleeps = (item: ReviewItemPayload) =>
    (snoozes[item.id]?.untilMs ?? 0) > nowMs;
  /** Snooze each item of a row or a stack until `untilMs`. */
  const snooze = (bundle: InboxBundle, untilMs: number) =>
    setSnoozes({
      ...snoozes,
      ...Object.fromEntries(bundle.items.map((item) => [item.id, { untilMs }])),
    });
  /** Snooze one item. The rest of its stack stays. */
  const snoozeItem = (item: ReviewItemPayload, untilMs: number) =>
    setSnoozes({ ...snoozes, [item.id]: { untilMs } });
  /** Wake each item of a row. */
  const wake = (bundle: InboxBundle) => {
    const ids = new Set(bundle.items.map((item) => item.id));
    setSnoozes(
      Object.fromEntries(
        Object.entries(snoozes).filter(([id]) => !ids.has(id)),
      ),
    );
  };
  /** Wake one item. The other items of its stack stay snoozed. */
  const wakeItem = (item: ReviewItemPayload) => {
    const { [item.id]: _woken, ...rest } = snoozes;
    setSnoozes(rest);
  };
  /** When a row wakes: when its last item does. */
  const until = (bundle: InboxBundle) =>
    Math.max(...bundle.items.map((item) => snoozes[item.id]?.untilMs ?? 0));
  return { sleeps, snooze, snoozeItem, until, wake, wakeItem };
}
