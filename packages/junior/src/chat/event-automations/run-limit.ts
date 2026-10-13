/**
 * Caps how often one Event automation can start a run.
 *
 * The cap applies to each Automation, not to a trigger type. A noisy trigger
 * blocks only the Automation that it fires. Each run costs a full agent Turn,
 * and Event automations do not use the consecutive automated-turn limit.
 * `botConfig.maxEventAutomationRunsPerHour` sets the cap. The window is fixed.
 */
import type { StateAdapter } from "chat";
import { z } from "zod";
import { botConfig } from "@/chat/config";
import { getStateAdapter } from "@/chat/state/adapter";
import { MUTATION_LOCK_TTL_MS, withLock } from "@/chat/state/locks";

const RUN_LIMIT_PREFIX = "junior:event_automation_run_limit:v1";
const RUN_LIMIT_LOCK_WAIT_MS = 2_000;

/** Length of the rolling window for the run limit. */
export const EVENT_AUTOMATION_RUN_WINDOW_MS = 60 * 60 * 1000;

const runLogSchema = z.array(
  z
    .object({
      atMs: z.number().finite().nonnegative(),
      key: z.string().min(1),
    })
    .strict(),
);

type RunLog = z.output<typeof runLogSchema>;

function runLogKey(automationId: string): string {
  return `${RUN_LIMIT_PREFIX}:${automationId}`;
}

function parseRunLog(value: unknown): RunLog {
  const parsed = runLogSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Reason stored on an Event automation that the run limit blocked. */
export function eventAutomationRunLimitReason(): string {
  return (
    `This automation started ${botConfig.maxEventAutomationRunsPerHour} runs in the last hour, ` +
    "the most one automation can start. Check that its trigger is not too broad, then resume it."
  );
}

/** Run one change to an automation's run log under its lock. */
async function withRunLog<T>(
  automationId: string,
  state: StateAdapter,
  run: (key: string) => Promise<T>,
): Promise<T> {
  await state.connect();
  const key = runLogKey(automationId);
  const result = await withLock(state, `${key}:lock`, () => run(key), {
    ttlMs: MUTATION_LOCK_TTL_MS,
    waitMs: RUN_LIMIT_LOCK_WAIT_MS,
  });
  if (!result.acquired) {
    throw new Error(
      `Could not acquire event automation run limit lock for ${automationId}`,
    );
  }
  return result.value;
}

/**
 * Admit one run of an Event automation, or refuse when its window is full.
 *
 * `runKey` is the dispatch idempotency key. A provider retry of the same Event
 * uses the same key, so it does not count again.
 */
export async function admitEventAutomationRun(args: {
  automationId: string;
  nowMs: number;
  runKey: string;
  state?: StateAdapter;
}): Promise<"allowed" | "limited"> {
  const state = args.state ?? getStateAdapter();
  return await withRunLog(args.automationId, state, async (key) => {
    const windowStartMs = args.nowMs - EVENT_AUTOMATION_RUN_WINDOW_MS;
    const log = parseRunLog(await state.get(key)).filter(
      (entry) => entry.atMs > windowStartMs,
    );
    if (log.some((entry) => entry.key === args.runKey)) {
      return "allowed" as const;
    }
    if (log.length >= botConfig.maxEventAutomationRunsPerHour) {
      return "limited" as const;
    }
    log.push({ atMs: args.nowMs, key: args.runKey });
    await state.set(key, log, EVENT_AUTOMATION_RUN_WINDOW_MS);
    return "allowed" as const;
  });
}

/**
 * Forget the runs counted for one Event automation.
 *
 * Resume and revive call this so the automation starts with a new window.
 * Call it while the automation cannot match Events, before it becomes active.
 * Otherwise an Event between activation and this call could see the old full
 * window and block the automation again. The admission lock keeps an
 * in-progress admission from writing the old log back.
 */
export async function clearEventAutomationRuns(
  automationId: string,
  state: StateAdapter = getStateAdapter(),
): Promise<void> {
  await withRunLog(automationId, state, async (key) => {
    await state.delete(key);
  });
}
