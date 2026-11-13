import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useReducer } from "react";

import type { InboxBundle } from "./reviewItemFormat";

const STORAGE_KEY = "junior:inbox:snoozed";
const HOUR_MS = 60 * 60 * 1000;
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One snoozed row: until when, and its newest item at the snooze. */
type Snooze = { newestItemId: string; untilMs: number };

/**
 * Every key that can snooze a row: the row itself, its Conversation, and
 * its items. A row can show under another entry's key.
 */
function rowKeys(bundle: InboxBundle): Set<string> {
  return new Set([
    bundle.key,
    bundle.conversationId,
    ...bundle.items.map((item) => item.id),
  ]);
}

/** A snooze choice, such as "Tomorrow". */
export type SnoozeChoice = { label: string; untilMs(nowMs: number): number };

function nextMorning(nowMs: number, days: number): number {
  const date = new Date(nowMs);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}

/** The snooze choices, in menu order. Number keys pick them. */
export const snoozeChoices: readonly SnoozeChoice[] = [
  { label: "3 hours", untilMs: (nowMs) => nowMs + 3 * HOUR_MS },
  { label: "Tomorrow", untilMs: (nowMs) => nextMorning(nowMs, 1) },
  { label: "Next week", untilMs: (nowMs) => nextMorning(nowMs, 7) },
];

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
 * The newest item of each row that sleeps now, sorted, so the server can
 * count the snoozed rows that are still open.
 */
export function useSnoozedItemIds(): string[] {
  const [snoozes] = useStoredSnoozes();
  const nowMs = Date.now();
  useWakeAtNextEnd(snoozes, nowMs);
  return [
    ...new Set(
      Object.values(snoozes)
        .filter((snooze) => snooze.untilMs > nowMs)
        .map((snooze) => snooze.newestItemId),
    ),
  ].sort();
}

/**
 * Snooze inbox rows in this browser. A row is a Conversation bundle or one
 * item; its `key` names it. A Conversation bundle wakes at its time, or as
 * soon as its Conversation adds a newer item. The server has no snooze, so
 * other browsers do not see it; the nav count names the snoozed items to
 * the server (`useSnoozedItemIds`).
 */
export function useInboxSnoozes(nowMs: number) {
  const [snoozes, setSnoozes] = useStoredSnoozes();
  useWakeAtNextEnd(snoozes, nowMs);
  /** True while `key` sleeps and `newestItemId` is still its newest item. */
  const sleeps = (key: string, newestItemId: string) => {
    const snooze = snoozes[key];
    return (
      snooze !== undefined &&
      snooze.untilMs > nowMs &&
      snooze.newestItemId === newestItemId
    );
  };
  const snooze = (bundle: InboxBundle, choice: SnoozeChoice) =>
    setSnoozes({
      ...snoozes,
      [bundle.key]: {
        newestItemId: bundle.newest.id,
        untilMs: choice.untilMs(nowMs),
      },
    });
  /** Wake the row and every key in it: its Conversation and its items. */
  const wake = (bundle: InboxBundle) => {
    const keys = rowKeys(bundle);
    setSnoozes(
      Object.fromEntries(
        Object.entries(snoozes).filter(([key]) => !keys.has(key)),
      ),
    );
  };
  const until = (bundle: InboxBundle) =>
    Math.max(...[...rowKeys(bundle)].map((key) => snoozes[key]?.untilMs ?? 0));
  return { sleeps, snooze, until, wake };
}
