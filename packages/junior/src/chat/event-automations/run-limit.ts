/**
 * Caps how often one Event automation can start a run.
 *
 * The cap applies to each Automation, not to a trigger type. A noisy trigger
 * blocks only the Automation that it fires. Each run costs a full agent Turn,
 * and Event automations do not use the consecutive automated-turn limit.
 * `botConfig.maxEventAutomationRunsPerHour` sets the cap.
 *
 * This is a plain fixed-window counter in the state adapter. It takes no lock,
 * so two Events at the same moment can both pass with the same count. A cap
 * that is off by a run or two is acceptable here.
 */
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";

const RUN_COUNT_PREFIX = "junior:event_automation_run_count:v1";

/** Length of the window for the run limit. */
export const EVENT_AUTOMATION_RUN_WINDOW_MS = 60 * 60 * 1000;

const runCountSchema = z
  .object({
    count: z.number().int().nonnegative(),
    windowStartMs: z.number().finite().nonnegative(),
  })
  .strict();

function runCountKey(automationId: string): string {
  return `${RUN_COUNT_PREFIX}:${automationId}`;
}

/** Reason stored on an Event automation that the run limit blocked. */
export function eventAutomationRunLimitReason(): string {
  return (
    `This automation started ${botConfig.maxEventAutomationRunsPerHour} runs in the last hour, ` +
    "the most one automation can start. Check that its trigger is not too broad, then resume it."
  );
}

/**
 * Count one run of an Event automation, or refuse when its window is full.
 *
 * The window starts at the first run and lasts one hour.
 */
export async function admitEventAutomationRun(args: {
  automationId: string;
  nowMs: number;
  state?: StateAdapter;
}): Promise<"allowed" | "limited"> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const key = runCountKey(args.automationId);
  const stored = runCountSchema.safeParse(await state.get(key));
  const current =
    stored.success &&
    stored.data.windowStartMs + EVENT_AUTOMATION_RUN_WINDOW_MS > args.nowMs
      ? stored.data
      : { count: 0, windowStartMs: args.nowMs };
  if (current.count >= botConfig.maxEventAutomationRunsPerHour) {
    return "limited";
  }
  await state.set(
    key,
    { count: current.count + 1, windowStartMs: current.windowStartMs },
    current.windowStartMs + EVENT_AUTOMATION_RUN_WINDOW_MS - args.nowMs,
  );
  return "allowed";
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
  await state.connect();
  await state.delete(runCountKey(automationId));
}
