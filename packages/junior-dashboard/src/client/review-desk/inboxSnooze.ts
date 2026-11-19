import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useReducer } from "react";

import type { ReviewItemPayload } from "@sentry/junior/api/schema";

import type { InboxBundle } from "./reviewItemFormat";

const STORAGE_KEY = "junior:inbox:snoozed";
const HOUR_MS = 60 * 60 * 1000;
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One snoozed item, by its id: until when. An item snooze that has ended
 * marks a woken item while a legacy row snooze still covers it.
 *
 * A legacy row snooze, from before items snoozed one by one, also has
 * `newestItemId`: it put away a whole row, under the row's Conversation or
 * item id, up to its newest item. `newestCreatedAt` is set once that item
 * loads.
 */
type Snooze = {
  newestCreatedAt?: string;
  newestItemId?: string;
  untilMs: number;
};

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

/** True when a legacy row snooze put this item away. */
function legacyCovers(
  key: string,
  snooze: Snooze,
  item: ReviewItemPayload,
): boolean {
  if (key === item.id) return true;
  if (key !== item.addedByConversationId && key !== item.rootConversationId)
    return false;
  // Its newest item may have closed, so the row is awake until that item
  // loads and dates the cutoff.
  return (
    snooze.newestCreatedAt !== undefined &&
    item.createdAt <= snooze.newestCreatedAt
  );
}

/**
 * When the item wakes, or 0. Its own snooze wins. Else a legacy row snooze
 * that put it away, so an item that loads on a later page stays asleep too.
 */
function snoozeUntil(
  snoozes: Record<string, Snooze>,
  item: ReviewItemPayload,
): number {
  const own = snoozes[item.id];
  if (own && !own.newestItemId) return own.untilMs;
  let untilMs = 0;
  for (const [key, snooze] of Object.entries(snoozes)) {
    if (snooze.newestItemId && legacyCovers(key, snooze, item))
      untilMs = Math.max(untilMs, snooze.untilMs);
  }
  return untilMs;
}

/**
 * Turns each legacy row snooze into snoozes of the loaded items that it put
 * away. The legacy snooze stays until it ends, so items that load later
 * convert too. A later item stays awake, so it shows by itself. Drops ended
 * snoozes once no legacy snooze is left. Returns undefined when nothing
 * changes.
 */
function itemSnoozes(
  snoozes: Record<string, Snooze>,
  items: readonly ReviewItemPayload[],
  nowMs: number,
): Record<string, Snooze> | undefined {
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = { ...snoozes };
  let changed = false;
  for (const [key, snooze] of Object.entries(snoozes)) {
    if (!snooze.newestItemId) continue;
    if (snooze.untilMs <= nowMs) {
      delete next[key];
      changed = true;
      continue;
    }
    const newest = byId.get(snooze.newestItemId);
    if (!newest) continue;
    const legacy = { ...snooze, newestCreatedAt: newest.createdAt };
    if (!snooze.newestCreatedAt) {
      next[key] = legacy;
      changed = true;
    }
    for (const item of items) {
      if (item.id === key || next[item.id]) continue;
      if (!legacyCovers(key, legacy, item)) continue;
      next[item.id] = { untilMs: snooze.untilMs };
      changed = true;
    }
  }
  if (!Object.values(next).some((snooze) => snooze.newestItemId)) {
    for (const [id, snooze] of Object.entries(next)) {
      if (snooze.untilMs > nowMs) continue;
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : undefined;
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
  // A legacy row snooze names its newest item.
  const ids = Object.entries(snoozes)
    .filter(([, snooze]) => snooze.untilMs > nowMs)
    .map(([id, snooze]) => snooze.newestItemId ?? id);
  return [...new Set(ids)].sort();
}

/**
 * Snooze Inbox items in this browser, each by its id. A row snoozes its
 * item, and a stack's Snooze snoozes each of its items until the same
 * time. Each item wakes at its time. An item that arrives later is not
 * snoozed, so it shows by itself while the rest stay in Snoozed. The
 * server has no snooze, so other browsers do not see it; the nav count
 * names the snoozed items to the server (`useSnoozedItemIds`).
 */
export function useInboxSnoozes(
  nowMs: number,
  items: readonly ReviewItemPayload[],
) {
  const [stored, setSnoozes] = useStoredSnoozes();
  const converted = itemSnoozes(stored, items, nowMs);
  // Keep the converted snoozes, so a Wake or a Snooze writes item snoozes.
  useEffect(() => {
    if (converted) setSnoozes(converted);
  });
  const snoozes = converted ?? stored;
  useWakeAtNextEnd(snoozes, nowMs);
  /** True while the item sleeps. */
  const sleeps = (item: ReviewItemPayload) =>
    snoozeUntil(snoozes, item) > nowMs;
  /** Snooze each item of a row or a stack until `untilMs`. */
  const snooze = (bundle: InboxBundle, untilMs: number) =>
    setSnoozes({
      ...snoozes,
      ...Object.fromEntries(bundle.items.map((item) => [item.id, { untilMs }])),
    });
  /** Snooze one item. The rest of its stack stays. */
  const snoozeItem = (item: ReviewItemPayload, untilMs: number) =>
    setSnoozes({ ...snoozes, [item.id]: { untilMs } });
  // A woken item keeps an ended snooze, so a legacy row snooze does not
  // put it away again; `itemSnoozes` drops it with the last legacy snooze.
  /** Wake each item of a row. */
  const wake = (bundle: InboxBundle) =>
    setSnoozes({
      ...snoozes,
      ...Object.fromEntries(
        bundle.items.map((item) => [item.id, { untilMs: nowMs }]),
      ),
    });
  /** Wake one item. The other items of its stack stay snoozed. */
  const wakeItem = (item: ReviewItemPayload) =>
    setSnoozes({ ...snoozes, [item.id]: { untilMs: nowMs } });
  /** When a row wakes: when its last item does. */
  const until = (bundle: InboxBundle) =>
    Math.max(...bundle.items.map((item) => snoozeUntil(snoozes, item)));
  return { sleeps, snooze, snoozeItem, until, wake, wakeItem };
}
