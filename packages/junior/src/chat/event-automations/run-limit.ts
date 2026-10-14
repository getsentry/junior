/**
 * Caps how often one Event automation can start a run.
 *
 * The cap applies to each Automation, not to a trigger type. A noisy trigger
 * blocks only the Automation that it fires. Each run costs a full agent Turn,
 * and Event automations do not use the consecutive automated-turn limit.
 * `botConfig.maxEventAutomationRunsPerHour` sets the cap.
 *
 * Each run appends one entry with its own id to a short list in the state
 * adapter. Then it counts the entries from the last hour up to its own entry.
 * The append is atomic, so the list order decides which runs fit, even when
 * Events arrive at the same moment. The first runs up to the cap pass, and the
 * rest are refused. No lock and no read-modify-write are needed.
 */
import { randomUUID } from "node:crypto";
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";

const RUN_LIST_PREFIX = "junior:event_automation_runs:v1";
// Extra entries kept past the cap. A run looks for its own entry, so it must
// stay in the list while other Events of the same burst append after it.
const RUN_LIST_BURST_ROOM = 100;

/** Length of the rolling window for the run limit. */
export const EVENT_AUTOMATION_RUN_WINDOW_MS = 60 * 60 * 1000;

// A reset entry marks a resume or revive. Runs before it do not count.
const runEntrySchema = z.union([
  z.object({ atMs: z.number().finite(), id: z.string().min(1) }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);

type RunEntry = z.output<typeof runEntrySchema>;

function runListKey(automationId: string): string {
  return `${RUN_LIST_PREFIX}:${automationId}`;
}

async function appendRunEntry(
  state: StateAdapter,
  automationId: string,
  entry: RunEntry,
): Promise<void> {
  await state.connect();
  await state.appendToList(runListKey(automationId), entry, {
    maxLength: botConfig.maxEventAutomationRunsPerHour + RUN_LIST_BURST_ROOM,
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
  const id = randomUUID();
  await appendRunEntry(state, args.automationId, { atMs: args.nowMs, id });
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
    if ("id" in entry.data && entry.data.id === id) {
      return count > botConfig.maxEventAutomationRunsPerHour
        ? "limited"
        : "allowed";
    }
  }
  // More Events than the burst room arrived after this one, so the hour is full.
  return "limited";
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
