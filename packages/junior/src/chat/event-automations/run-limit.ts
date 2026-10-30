/**
 * Caps how often one Event automation can start a run.
 *
 * The cap applies to each Automation, not to a trigger type. A noisy trigger
 * blocks only the Automation that it fires. Each run costs a full agent Turn,
 * and Event automations do not use the consecutive automated-turn limit.
 * `botConfig.maxEventAutomationRuns` sets the cap, and
 * `botConfig.eventAutomationRunWindowMs` sets the rolling window.
 *
 * Each run appends one entry with its run key to a short list in the state
 * adapter. Then it counts the run keys from the last window up to the first
 * entry with its own key. The append is atomic, so the list order decides
 * which runs fit, even when Events arrive at the same moment. The first runs up to the cap
 * pass, and the rest are refused. A provider retry has the same run key, so it
 * gets the same answer and does not count again. No lock is needed.
 *
 * A run does not append its key when the list already has it. A trigger with
 * no identifier gets one copy of an Event for each scope, such as each
 * project of a metric alert, and all copies have one run key. Repeated
 * entries would fill the list and block the automation, so the limit stays
 * the same however broad the trigger is. Two copies at the same moment can
 * still both append, and they count as one run.
 */
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";

const RUN_LIST_PREFIX = "junior:event_automation_runs:v1";
// Extra entries kept past the cap. A run looks for its own entry, so it must
// stay in the list while other Events of the same burst append after it.
const RUN_LIST_BURST_ROOM = 100;

// A reset entry marks a resume or revive. Runs before it do not count.
const runEntrySchema = z.union([
  z.object({ atMs: z.number().finite(), id: z.string().min(1) }).strict(),
  z.object({ reset: z.literal(true) }).strict(),
]);

type RunEntry = z.output<typeof runEntrySchema>;

function runListKey(automationId: string): string {
  return `${RUN_LIST_PREFIX}:${automationId}`;
}

function runListMaxLength(): number {
  return botConfig.maxEventAutomationRuns + RUN_LIST_BURST_ROOM;
}

async function appendRunEntry(
  state: StateAdapter,
  automationId: string,
  entry: RunEntry,
): Promise<void> {
  await state.connect();
  await state.appendToList(runListKey(automationId), entry, {
    maxLength: runListMaxLength(),
    ttlMs: botConfig.eventAutomationRunWindowMs,
  });
}

// Name the window in the largest whole unit, such as "minute" or "2 hours".
function describeRunWindow(windowMs: number): string {
  const units: Array<[string, number]> = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
    ["second", 1000],
  ];
  for (const [unit, unitMs] of units) {
    if (windowMs % unitMs === 0) {
      const count = windowMs / unitMs;
      return count === 1 ? unit : `${count} ${unit}s`;
    }
  }
  return `${windowMs} ms`;
}

/** Reason stored on an Event automation that the run limit blocked. */
export function eventAutomationRunLimitReason(): string {
  const window = describeRunWindow(botConfig.eventAutomationRunWindowMs);
  return (
    `This automation reached its limit of ${botConfig.maxEventAutomationRuns} runs per ${window}. ` +
    "Check that its trigger is not too broad, then resume it."
  );
}

// True when the key has an entry after the last reset entry.
function hasRunKey(entries: readonly RunEntry[], runKey: string): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if ("reset" in entry) return false;
    if (entry.id === runKey) return true;
  }
  return false;
}

/**
 * Count one run of an Event automation, or refuse when its window is full.
 *
 * `runKey` is the dispatch idempotency key, so a provider retry of the same
 * Event does not count again.
 */
export async function admitEventAutomationRun(args: {
  automationId: string;
  nowMs: number;
  runKey: string;
  state?: StateAdapter;
}): Promise<"allowed" | "limited"> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const readEntries = async () => {
    const values = await state.getList(runListKey(args.automationId));
    const entries = values.flatMap((value) => {
      const entry = runEntrySchema.safeParse(value);
      return entry.success ? [entry.data] : [];
    });
    return { entries, length: values.length };
  };
  if (!hasRunKey((await readEntries()).entries, args.runKey)) {
    await appendRunEntry(state, args.automationId, {
      atMs: args.nowMs,
      id: args.runKey,
    });
  }
  const windowStartMs = args.nowMs - botConfig.eventAutomationRunWindowMs;
  const { entries, length } = await readEntries();
  // Only runs after the last reset count. A retry finds its entry there too,
  // so a resume or revive also clears the answer for an earlier delivery.
  let lastReset = -1;
  entries.forEach((entry, index) => {
    if ("reset" in entry) lastReset = index;
  });
  // A full list whose oldest entry is from this window may have dropped runs
  // from this window. Then the window is full, until a reset entry.
  const oldest = entries[0];
  const full =
    lastReset === -1 &&
    length >= runListMaxLength() &&
    oldest !== undefined &&
    "atMs" in oldest &&
    oldest.atMs > windowStartMs;
  const runKeys = new Set<string>();
  for (const entry of entries.slice(lastReset + 1)) {
    if ("reset" in entry) continue;
    if (entry.atMs > windowStartMs) {
      runKeys.add(entry.id);
    }
    if (entry.id === args.runKey) {
      return full || runKeys.size > botConfig.maxEventAutomationRuns
        ? "limited"
        : "allowed";
    }
  }
  // More Events than the burst room arrived after this one, so the window is
  // full.
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
