import type { AutomationSummary } from "@sentry/junior/api/schema";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useReducer } from "react";

import type { SnoozeChoice } from "./inboxSnooze";

// Kept apart from the item snoozes: the server will own both later, and
// Automation alerts are not Review items, so the server count never sees
// these keys.
const STORAGE_KEY = "junior:inbox:automation-alerts";
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** An alert the viewer put away: for good, or until a time. */
type PutAway = { alert: string; untilMs?: number };

/**
 * What an Automation alert says now. A new failure, run, or blocked reason
 * changes it, so a dismissed or snoozed alert shows again.
 */
function alertIdentity(automation: AutomationSummary): string {
  const problems =
    automation.kind === "event" ? automation.trigger.problems : [];
  return JSON.stringify([
    automation.status,
    automation.statusReason ?? null,
    automation.lastRunStatus ?? null,
    automation.lastRunAt ?? null,
    problems,
  ]);
}

/**
 * Dismiss or snooze the viewer's Automation alerts in To do, in this
 * browser. Each one hides until its alert changes, and a snoozed one also
 * wakes at its time.
 */
export function useAutomationAlerts(nowMs: number) {
  const [stored, setStored] = useLocalStorage<Record<string, PutAway>>(
    STORAGE_KEY,
    {},
  );
  const [, wakeUp] = useReducer((count: number) => count + 1, 0);
  const nextWakeMs = Math.min(
    ...Object.values(stored)
      .map((entry) => entry.untilMs ?? Infinity)
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

  const hidden = (automation: AutomationSummary) => {
    const entry = stored[automation.id];
    return (
      entry !== undefined &&
      entry.alert === alertIdentity(automation) &&
      (entry.untilMs === undefined || entry.untilMs > nowMs)
    );
  };
  const putAway = (automation: AutomationSummary, untilMs?: number) =>
    setStored({
      ...stored,
      [automation.id]: { alert: alertIdentity(automation), untilMs },
    });
  return {
    dismiss: (automation: AutomationSummary) => putAway(automation),
    hidden,
    snooze: (automation: AutomationSummary, choice: SnoozeChoice) =>
      putAway(automation, choice.untilMs(nowMs)),
  };
}
