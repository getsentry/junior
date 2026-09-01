/**
 * Caps consecutive automated turns so event wakes cannot loop forever.
 *
 * A conversation pause key covers resource-event watches on one conversation.
 * A destination pause key covers event-task and other agent dispatches that
 * deliver into the same Slack channel without sharing a conversation id.
 * A user-owned turn clears both scopes it can name.
 */
import type { Destination, Source } from "@sentry/junior-plugin-api";
import type { Lock, StateAdapter } from "chat";
import { z } from "zod";
import { destinationKey } from "@/chat/destination";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const AUTOMATED_TURN_LIMIT_PREFIX = "junior:automated_turn_limit:v1";
const AUTOMATED_TURN_LIMIT_LOCK_TTL_MS = 5_000;
const AUTOMATED_TURN_LIMIT_LOCK_WAIT_MS = 2_000;
const AUTOMATED_TURN_LIMIT_LOCK_RETRY_MS = 25;

/** Redis record for one automated-turn pause scope. */
const automatedTurnLimitRecordSchema = z
  .object({
    consecutiveAutomatedTurns: z.number().int().nonnegative(),
    noticePostedAtMs: z.number().finite().nonnegative().optional(),
    paused: z.boolean(),
    updatedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

export type AutomatedTurnLimitRecord = z.output<
  typeof automatedTurnLimitRecordSchema
>;

export type AutomatedTurnLimitScope =
  | { kind: "conversation"; conversationId: string }
  | { kind: "destination"; destination: Destination };

export type AutomatedTurnLimitDecision =
  | { status: "allow"; consecutiveAutomatedTurns: number }
  | {
      status: "paused";
      consecutiveAutomatedTurns: number;
      shouldPostNotice: boolean;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function scopeKey(scope: AutomatedTurnLimitScope): string {
  if (scope.kind === "conversation") {
    return `${AUTOMATED_TURN_LIMIT_PREFIX}:conversation:${scope.conversationId}`;
  }
  return `${AUTOMATED_TURN_LIMIT_PREFIX}:destination:${destinationKey(scope.destination)}`;
}

function lockKey(key: string): string {
  return `${key}:lock`;
}

function parseRecord(value: unknown): AutomatedTurnLimitRecord | undefined {
  const parsed = automatedTurnLimitRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function acquireScopeLock(
  state: StateAdapter,
  key: string,
  waitDeadlineMs = Date.now() + AUTOMATED_TURN_LIMIT_LOCK_WAIT_MS,
): Promise<Lock> {
  while (true) {
    const lock = await state.acquireLock(
      lockKey(key),
      AUTOMATED_TURN_LIMIT_LOCK_TTL_MS,
    );
    if (lock) {
      return lock;
    }
    if (Date.now() >= waitDeadlineMs) {
      throw new Error(`Could not acquire automated turn limit lock for ${key}`);
    }
    await sleep(AUTOMATED_TURN_LIMIT_LOCK_RETRY_MS);
  }
}

async function withScopeLock<T>(
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await acquireScopeLock(state, key);
  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

function emptyRecord(nowMs: number): AutomatedTurnLimitRecord {
  return {
    consecutiveAutomatedTurns: 0,
    paused: false,
    updatedAtMs: nowMs,
  };
}

/** True when this Source starts an automated turn rather than a user turn. */
export function isAutomatedTurnSource(source: Source | undefined): boolean {
  if (!source) {
    return false;
  }
  return (
    source.kind === "resource_event" ||
    source.kind === "event_task" ||
    source.kind === "scheduled_task" ||
    source.kind === "plugin_dispatch" ||
    source.kind === "agent_invocation"
  );
}

/** User-facing copy when automated updates pause for one conversation. */
export function buildAutomatedTurnLimitResponse(maxTurns: number): string {
  return (
    `I paused automated updates after ${maxTurns} consecutive event-driven turns without a user message. ` +
    "Send a message or @mention me in this thread to resume. " +
    "New resource events will stay quiet until then."
  );
}

/** Read the current pause record for one scope. */
export async function getAutomatedTurnLimitRecord(args: {
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitRecord> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  return parseRecord(await state.get(scopeKey(args.scope))) ?? emptyRecord(nowMs);
}

/**
 * Admit one automated wake, or pause further wakes once the streak is full.
 * The first refused wake asks the caller to post the pause notice once.
 */
export async function admitAutomatedTurn(args: {
  maxTurns: number;
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitDecision> {
  if (args.maxTurns < 1) {
    throw new Error("Automated turn limit must be at least 1");
  }
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  const key = scopeKey(args.scope);
  return await withScopeLock(state, key, async () => {
    const current = parseRecord(await state.get(key)) ?? emptyRecord(nowMs);
    if (current.paused || current.consecutiveAutomatedTurns >= args.maxTurns) {
      const shouldPostNotice = current.noticePostedAtMs === undefined;
      const next: AutomatedTurnLimitRecord = {
        consecutiveAutomatedTurns: Math.max(
          current.consecutiveAutomatedTurns,
          args.maxTurns,
        ),
        paused: true,
        updatedAtMs: nowMs,
        ...(shouldPostNotice
          ? { noticePostedAtMs: nowMs }
          : current.noticePostedAtMs !== undefined
            ? { noticePostedAtMs: current.noticePostedAtMs }
            : undefined),
      };
      await state.set(key, next, JUNIOR_THREAD_STATE_TTL_MS);
      return {
        status: "paused" as const,
        consecutiveAutomatedTurns: next.consecutiveAutomatedTurns,
        shouldPostNotice,
      };
    }
    return {
      status: "allow" as const,
      consecutiveAutomatedTurns: current.consecutiveAutomatedTurns,
    };
  });
}

/** Charge one finished automated turn against the consecutive-turn budget. */
export async function chargeAutomatedTurn(args: {
  maxTurns: number;
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitRecord> {
  if (args.maxTurns < 1) {
    throw new Error("Automated turn limit must be at least 1");
  }
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  const key = scopeKey(args.scope);
  return await withScopeLock(state, key, async () => {
    const current = parseRecord(await state.get(key)) ?? emptyRecord(nowMs);
    const consecutiveAutomatedTurns = current.consecutiveAutomatedTurns + 1;
    const paused = consecutiveAutomatedTurns >= args.maxTurns;
    const next: AutomatedTurnLimitRecord = {
      consecutiveAutomatedTurns,
      paused,
      updatedAtMs: nowMs,
      ...(current.noticePostedAtMs !== undefined
        ? { noticePostedAtMs: current.noticePostedAtMs }
        : undefined),
    };
    await state.set(key, next, JUNIOR_THREAD_STATE_TTL_MS);
    return next;
  });
}

/** Clear the consecutive automated-turn streak after a user-owned turn. */
export async function resetAutomatedTurnLimit(args: {
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<void> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const key = scopeKey(args.scope);
  await withScopeLock(state, key, async () => {
    await state.delete(key);
  });
}

/**
 * Apply one finished turn to the automated-turn budgets it owns.
 *
 * Automated turns charge their conversation and destination scopes. User turns
 * clear both scopes so later event wakes can run again.
 */
export async function recordFinishedTurnForAutomatedLimit(args: {
  conversationId: string;
  destination?: Destination;
  maxTurns: number;
  nowMs?: number;
  source?: Source;
  state?: StateAdapter;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const conversationScope: AutomatedTurnLimitScope = {
    kind: "conversation",
    conversationId: args.conversationId,
  };
  const destinationScope: AutomatedTurnLimitScope | undefined = args.destination
    ? { kind: "destination", destination: args.destination }
    : undefined;

  if (isAutomatedTurnSource(args.source)) {
    await chargeAutomatedTurn({
      maxTurns: args.maxTurns,
      nowMs,
      scope: conversationScope,
      state: args.state,
    });
    if (destinationScope) {
      await chargeAutomatedTurn({
        maxTurns: args.maxTurns,
        nowMs,
        scope: destinationScope,
        state: args.state,
      });
    }
    return;
  }

  // Unknown or user Sources clear the pause so the next event wake can run.
  await resetAutomatedTurnLimit({
    nowMs,
    scope: conversationScope,
    state: args.state,
  });
  if (destinationScope) {
    await resetAutomatedTurnLimit({
      nowMs,
      scope: destinationScope,
      state: args.state,
    });
  }
}
