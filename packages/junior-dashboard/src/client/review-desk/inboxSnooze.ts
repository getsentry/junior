import { useLocalStorage } from "@uidotdev/usehooks";

import type { InboxBundle } from "./reviewItemFormat";

const STORAGE_KEY = "junior:inbox:snoozed";
const HOUR_MS = 60 * 60 * 1000;

/** One snoozed bundle: until when, and its newest item at the snooze. */
type Snooze = { newestItemId: string; untilMs: number };

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

/**
 * Snooze inbox bundles in this browser. A bundle wakes at its time, or as
 * soon as its Conversation adds a newer item. Prototype: the server has no
 * snooze, so other browsers and the nav count do not see it.
 */
export function useInboxSnoozes(nowMs: number) {
  const [snoozes, setSnoozes] = useLocalStorage<Record<string, Snooze>>(
    STORAGE_KEY,
    {},
  );
  const isSnoozed = (bundle: InboxBundle) => {
    const snooze = snoozes[bundle.conversationId];
    return (
      snooze !== undefined &&
      snooze.untilMs > nowMs &&
      snooze.newestItemId === bundle.newest.id
    );
  };
  const snooze = (bundle: InboxBundle, choice: SnoozeChoice) =>
    setSnoozes({
      ...snoozes,
      [bundle.conversationId]: {
        newestItemId: bundle.newest.id,
        untilMs: choice.untilMs(nowMs),
      },
    });
  const wake = (bundle: InboxBundle) => {
    const { [bundle.conversationId]: _woken, ...rest } = snoozes;
    setSnoozes(rest);
  };
  const until = (bundle: InboxBundle) =>
    snoozes[bundle.conversationId]?.untilMs;
  return { isSnoozed, snooze, until, wake };
}
