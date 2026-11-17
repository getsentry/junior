const HOUR_MS = 60 * 60 * 1000;

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
