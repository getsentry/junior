import type { AutomationListItem } from "@sentry/junior/api/schema";
import { useLocalStorage } from "@uidotdev/usehooks";
import { useEffect, useReducer } from "react";

import type { SnoozeChoice } from "./snoozeChoices";

// Item snoozes live on the server as wake Automations. An Automation alert
// is not a Review item, so no wake Automation can hide it; it is put away in
// this browser, and the server count never sees these keys.
const STORAGE_KEY = "junior:inbox:automation-alerts";
/** The longest delay `setTimeout` keeps; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** An alert the viewer put away: for good, or until a time. */
type PutAway = { alert: string; untilMs?: number };

/**
 * What an Automation alert says now. A new failure, run, or blocked reason
 * changes it, so a dismissed or snoozed alert shows again.
 */
function alertIdentity(automation: AutomationListItem): string {
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

  const hidden = (automation: AutomationListItem) => {
    const entry = stored[automation.id];
    return (
      entry !== undefined &&
      entry.alert === alertIdentity(automation) &&
      (entry.untilMs === undefined || entry.untilMs > nowMs)
    );
  };
  const putAway = (automation: AutomationListItem, untilMs?: number) =>
    setStored({
      ...stored,
      [automation.id]: { alert: alertIdentity(automation), untilMs },
    });
  return {
    /** True while some alert is put away, so a count must wait for the list. */
    anyPutAway: Object.values(stored).some(
      (entry) => entry.untilMs === undefined || entry.untilMs > nowMs,
    ),
    dismiss: (automation: AutomationListItem) => putAway(automation),
    hidden,
    snooze: (automation: AutomationListItem, choice: SnoozeChoice) =>
      putAway(automation, choice.untilMs(nowMs)),
  };
}
