/**
 * Caps how often one Event automation can start a run.
 *
 * The cap applies to each Automation, not to a trigger type. A noisy trigger
 * blocks only the Automation that it fires. Each run costs a full agent Turn,
 * and Event automations do not use the consecutive automated-turn limit.
 * `botConfig.maxEventAutomationRunsPerHour` sets the cap.
 *
 * Each run appends one entry to a short list in the state adapter, then counts
 * the entries from the last hour. The append is atomic, so the run that goes
 * over the cap always sees it, even when Events arrive at the same moment. No
 * lock and no read-modify-write are needed. A burst can refuse runs that would
 * fit, because each run counts the entries that arrived after it too. Then the
 * Automation blocks, which is the safe side for a cap.
 */
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";

const RUN_LIST_PREFIX = "junior:event_automation_runs:v1";

/** Length of the rolling window for the run limit. */
export const EVENT_AUTOMATION_RUN_WINDOW_MS = 60 * 60 * 1000;

// A reset entry marks a resume or revive. Runs before it do not count.
const runEntrySchema = z.union([
  z.object({ atMs: z.number().finite() }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);

type RunEntry = z.output<typeof runEntrySchema>;

function runListKey(automationId: string): string {
  return `${RUN_LIST_PREFIX}:${automationId}`;
}

// The newest cap + 1 entries are enough to tell whether a run is over the cap.
async function appendRunEntry(
  state: StateAdapter,
  automationId: string,
  entry: RunEntry,
): Promise<void> {
  await state.connect();
  await state.appendToList(runListKey(automationId), entry, {
    maxLength: botConfig.maxEventAutomationRunsPerHour + 1,
    ttlMs: EVENT_AUTOMATION_RUN_WINDOW_MS,
  });
}

/** Reason stored on an Event automation that the run limit blocked. */
export function eventAutomationRunLimitReason(): string {
  return (
    `This automation reached its limit of ${botConfig.maxEventAutomationRunsPerHour} runs per hour. ` +
    "Check that its trigger is not too broad, then resume it."
  );
}

/** Count one run of an Event automation, or refuse when its hour is full. */
export async function admitEventAutomationRun(args: {
  automationId: string;
  nowMs: number;
  state?: StateAdapter;
}): Promise<"allowed" | "limited"> {
  const state = args.state ?? getStateAdapter();
  await appendRunEntry(state, args.automationId, { atMs: args.nowMs });
  const windowStartMs = args.nowMs - EVENT_AUTOMATION_RUN_WINDOW_MS;
  let count = 0;
  for (const value of await state.getList(runListKey(args.automationId))) {
    const entry = runEntrySchema.safeParse(value);
    if (!entry.success) continue;
    if ("reset" in entry.data) {
      count = 0;
    } else if (entry.data.atMs > windowStartMs) {
      count += 1;
    }
  }
  return count > botConfig.maxEventAutomationRunsPerHour
    ? "limited"
    : "allowed";
}

/**
 * Forget the runs counted for one Event automation.
 *
 * Resume and revive call this so the automation starts with a new window.
 * Call it before the automation becomes active, so an Event cannot see the
 * old full count and block it again.
 */
export async function clearEventAutomationRuns(
  automationId: string,
  state: StateAdapter = getStateAdapter(),
): Promise<void> {
  await appendRunEntry(state, automationId, { reset: true });
}
