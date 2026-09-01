/**
 * Stops event wakes after too many automated Turns with no user Turn.
 *
 * Resource-event watches count on the Conversation. Event tasks and other
 * agent dispatches count on the Slack Destination. A finished user Turn clears
 * every scope that Turn can name.
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

/** Stored consecutive-turn limit for one Conversation or Destination. */
const automatedTurnLimitStateSchema = z
  .object({
    consecutiveAutomatedTurns: z.number().int().nonnegative(),
    noticePostedAtMs: z.number().finite().nonnegative().optional(),
    paused: z.boolean(),
    updatedAtMs: z.number().finite().nonnegative(),
  })
  .strict();

export type AutomatedTurnLimitState = z.output<
  typeof automatedTurnLimitStateSchema
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

export type AutomatedTurnLimitUpdate = {
  consecutiveAutomatedTurns: number;
  paused: boolean;
  shouldPostNotice: boolean;
  /** Where the pause notice should tell the user to reply. */
  resumeIn: "thread" | "channel";
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

function parseState(value: unknown): AutomatedTurnLimitState | undefined {
  const parsed = automatedTurnLimitStateSchema.safeParse(value);
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

function emptyState(nowMs: number): AutomatedTurnLimitState {
  return {
    consecutiveAutomatedTurns: 0,
    paused: false,
    updatedAtMs: nowMs,
  };
}

function resumeInForScope(scope: AutomatedTurnLimitScope): "thread" | "channel" {
  return scope.kind === "conversation" ? "thread" : "channel";
}

/** True when this Source starts an automated Turn rather than a user Turn. */
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

/**
 * Scope that counts automated Turns for this Source.
 * Resource-event watches stay on the Conversation. Dispatches use Destination.
 */
export function automatedTurnLimitScopeForSource(args: {
  conversationId: string;
  destination?: Destination;
  source?: Source;
}): AutomatedTurnLimitScope | undefined {
  if (!isAutomatedTurnSource(args.source)) {
    return undefined;
  }
  if (args.source?.kind === "resource_event") {
    return {
      kind: "conversation",
      conversationId: args.conversationId,
    };
  }
  if (args.destination) {
    return { kind: "destination", destination: args.destination };
  }
  return {
    kind: "conversation",
    conversationId: args.conversationId,
  };
}

/** Plain notice when automatic updates stop until the user replies. */
export function buildAutomatedTurnLimitResponse(args: {
  maxTurns: number;
  resumeIn?: "thread" | "channel";
}): string {
  const place = args.resumeIn === "channel" ? "channel" : "thread";
  return (
    `I stopped automatic updates after ${args.maxTurns} replies without a new message from you. ` +
    `Send a message or @mention me in this ${place} to continue.`
  );
}

/** Read the current consecutive-turn limit for one scope. */
export async function getAutomatedTurnLimitState(args: {
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitState> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  return parseState(await state.get(scopeKey(args.scope))) ?? emptyState(nowMs);
}

/**
 * Allow one automated wake, or refuse once the consecutive-turn limit is full.
 * If a prior pause never posted its notice, claim the notice slot so one caller
 * posts it. Clear the claim if that post fails or is skipped.
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
    const current = parseState(await state.get(key)) ?? emptyState(nowMs);
    if (current.paused || current.consecutiveAutomatedTurns >= args.maxTurns) {
      const shouldPostNotice = current.noticePostedAtMs === undefined;
      const next: AutomatedTurnLimitState = {
        consecutiveAutomatedTurns: Math.max(
          current.consecutiveAutomatedTurns,
          args.maxTurns,
        ),
        paused: true,
        updatedAtMs: nowMs,
        // Claim the notice slot so concurrent paused wakes do not all post.
        // Callers must mark success or clear the claim if the post fails.
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

/** Count one finished automated Turn toward the consecutive-turn limit. */
export async function countAutomatedTurn(args: {
  maxTurns: number;
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitUpdate> {
  if (args.maxTurns < 1) {
    throw new Error("Automated turn limit must be at least 1");
  }
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  const key = scopeKey(args.scope);
  const resumeIn = resumeInForScope(args.scope);
  return await withScopeLock(state, key, async () => {
    const current = parseState(await state.get(key)) ?? emptyState(nowMs);
    const consecutiveAutomatedTurns = current.consecutiveAutomatedTurns + 1;
    const paused = consecutiveAutomatedTurns >= args.maxTurns;
    const shouldPostNotice =
      paused && current.noticePostedAtMs === undefined;
    const next: AutomatedTurnLimitState = {
      consecutiveAutomatedTurns,
      paused,
      updatedAtMs: nowMs,
      // Claim the notice slot before the destination post. Mark success after
      // the post lands; clear the claim if the post fails or is skipped.
      ...(shouldPostNotice
        ? { noticePostedAtMs: nowMs }
        : current.noticePostedAtMs !== undefined
          ? { noticePostedAtMs: current.noticePostedAtMs }
          : undefined),
    };
    await state.set(key, next, JUNIOR_THREAD_STATE_TTL_MS);
    return {
      consecutiveAutomatedTurns,
      paused,
      shouldPostNotice,
      resumeIn,
    };
  });
}

/**
 * Drop a failed notice claim so a later paused wake can post the notice.
 * Keeps the pause and consecutive count.
 */
export async function clearAutomatedTurnLimitNoticeClaim(args: {
  nowMs?: number;
  scope: AutomatedTurnLimitScope;
  state?: StateAdapter;
}): Promise<void> {
  const state = args.state ?? getStateAdapter();
  await state.connect();
  const nowMs = args.nowMs ?? Date.now();
  const key = scopeKey(args.scope);
  await withScopeLock(state, key, async () => {
    const current = parseState(await state.get(key));
    if (!current || current.noticePostedAtMs === undefined) {
      return;
    }
    const { noticePostedAtMs: _noticePostedAtMs, ...rest } = current;
    await state.set(
      key,
      {
        ...rest,
        updatedAtMs: nowMs,
      },
      JUNIOR_THREAD_STATE_TTL_MS,
    );
  });
}

/** Clear the consecutive automated-turn count after a user-owned Turn. */
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
 * Update consecutive automated-turn limits after one finished Turn.
 *
 * Automated Turns count one matching scope. User Turns clear Conversation and
 * Destination scopes so later event wakes can run again.
 */
export async function recordFinishedTurnForAutomatedLimit(args: {
  conversationId: string;
  destination?: Destination;
  maxTurns: number;
  nowMs?: number;
  source?: Source;
  state?: StateAdapter;
}): Promise<AutomatedTurnLimitUpdate | undefined> {
  const nowMs = args.nowMs ?? Date.now();
  const automatedScope = automatedTurnLimitScopeForSource({
    conversationId: args.conversationId,
    destination: args.destination,
    source: args.source,
  });

  if (automatedScope) {
    return await countAutomatedTurn({
      maxTurns: args.maxTurns,
      nowMs,
      scope: automatedScope,
      state: args.state,
    });
  }

  await resetAutomatedTurnLimit({
    nowMs,
    scope: {
      kind: "conversation",
      conversationId: args.conversationId,
    },
    state: args.state,
  });
  if (args.destination) {
    await resetAutomatedTurnLimit({
      nowMs,
      scope: { kind: "destination", destination: args.destination },
      state: args.state,
    });
  }
  return undefined;
}
