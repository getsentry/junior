/**
 * Counts automated Turns in a row with no user Turn. At the limit, the
 * Turn that reached it stops the Conversation tree.
 *
 * Counts on the Conversation only. A finished user Turn clears the count.
 */
import type { Source } from "@sentry/junior-plugin-api";
import type { Lock, StateAdapter } from "chat";
import * as z from "zod";
import { getStateAdapter } from "@/chat/state/adapter";
import { JUNIOR_THREAD_STATE_TTL_MS } from "@/chat/state/ttl";

const AUTOMATED_TURN_LIMIT_PREFIX = "junior:automated_turn_limit:v1";
const AUTOMATED_TURN_LIMIT_LOCK_TTL_MS = 5_000;
const AUTOMATED_TURN_LIMIT_LOCK_WAIT_MS = 2_000;
const AUTOMATED_TURN_LIMIT_LOCK_RETRY_MS = 25;

/**
 * Stored consecutive automated-turn count for one Conversation. Parsing
 * strips the fields of the old pause, so its count still applies.
 */
const automatedTurnLimitStateSchema = z.object({
  consecutiveAutomatedTurns: z.number().int().nonnegative(),
  updatedAtMs: z.number().finite().nonnegative(),
});

export type AutomatedTurnLimitState = z.output<
  typeof automatedTurnLimitStateSchema
>;

export type AutomatedTurnLimitUpdate = {
  consecutiveAutomatedTurns: number;
  /** True when this Turn reached or passed the limit. */
  reached: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
  });
}

function conversationKey(conversationId: string): string {
  return `${AUTOMATED_TURN_LIMIT_PREFIX}:conversation:${conversationId}`;
}

function lockKey(key: string): string {
  return `${key}:lock`;
}

function parseState(value: unknown): AutomatedTurnLimitState | undefined {
  const parsed = automatedTurnLimitStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function acquireConversationLock(
  state: StateAdapter,
  key: string,
  waitDeadlineMs = Date.now() + AUTOMATED_TURN_LIMIT_LOCK_WAIT_MS,
): Promise<Lock> {
  /* oxlint-disable no-await-in-loop -- Poll the lock until it is free or the wait ends. */
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
  /* oxlint-enable no-await-in-loop */
}

async function withConversationLock<T>(
  state: StateAdapter,
  key: string,
  callback: () => Promise<T>,
): Promise<T> {
  const lock = await acquireConversationLock(state, key);
  try {
    return await callback();
  } finally {
    await state.releaseLock(lock);
  }
}

function emptyState(nowMs: number): AutomatedTurnLimitState {
  return {
    consecutiveAutomatedTurns: 0,
    updatedAtMs: nowMs,
  };
}

/**
 * True when this Source starts an automated Turn rather than a user Turn. A
 * parent agent's task clears the count, as a person's Message does.
 */
export function isAutomatedTurnSource(source: Source | undefined): boolean {
  if (!source) {
    return false;
  }
  return (
    source.kind === "event" ||
    source.kind === "event_automation" ||
    source.kind === "scheduled_automation" ||
    source.kind === "plugin_dispatch"
  );
}

/** Plain notice when automatic updates stop until the user replies. */
export function buildAutomatedTurnLimitResponse(args: {
  maxTurns: number;
}): string {
  return (
    `I stopped automatic updates after ${args.maxTurns} automated turns without a new message from you. ` +
    `Turns with no reply also count. ` +
    `Send a message or @mention me in this thread to continue.`
  );
}

/** Read the consecutive automated-turn count for one Conversation. */
export async function getAutomatedTurnLimitState(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitState> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  return (
    parseState(await state.get(conversationKey(args.conversationId))) ??
    emptyState(nowMs)
  );
}

/** Count one finished automated Turn toward the consecutive-turn limit. */
export async function countAutomatedTurn(args: {
  conversationId: string;
  maxTurns: number;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<AutomatedTurnLimitUpdate> {
  if (args.maxTurns < 1) {
    throw new Error("Automated turn limit must be at least 1");
  }
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  const key = conversationKey(args.conversationId);
  return await withConversationLock(state, key, async () => {
    const current = parseState(await state.get(key)) ?? emptyState(nowMs);
    const consecutiveAutomatedTurns = current.consecutiveAutomatedTurns + 1;
    await state.set(
      key,
      { consecutiveAutomatedTurns, updatedAtMs: nowMs },
      JUNIOR_THREAD_STATE_TTL_MS,
    );
    return {
      consecutiveAutomatedTurns,
      // A count from before a person's input can already exceed the limit.
      // Each Turn past it stops again, as the Turn that reached it did.
      reached: consecutiveAutomatedTurns >= args.maxTurns,
    };
  });
}

/** Clear the consecutive automated-turn count after a user-owned Turn. */
export async function resetAutomatedTurnLimit(args: {
  conversationId: string;
  nowMs?: number;
  state?: StateAdapter | undefined;
}): Promise<void> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const key = conversationKey(args.conversationId);
  await withConversationLock(state, key, async () => {
    await state.delete(key);
  });
}

/**
 * Update consecutive automated-turn counts after one finished Turn.
 *
 * Automated Turns count on the Conversation. User Turns clear that count.
 */
export async function recordFinishedTurnForAutomatedLimit(args: {
  conversationId: string;
  maxTurns: number;
  nowMs?: number;
  source?: Source;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitUpdate | undefined> {
  const nowMs = args.nowMs ?? Date.now();
  if (isAutomatedTurnSource(args.source)) {
    return await countAutomatedTurn({
      conversationId: args.conversationId,
      maxTurns: args.maxTurns,
      nowMs,
      state: args.state,
    });
  }

  await resetAutomatedTurnLimit({
    conversationId: args.conversationId,
    nowMs,
    state: args.state,
  });
  return undefined;
}
