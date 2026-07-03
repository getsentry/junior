import type { ThreadConversationState } from "@/chat/state/conversation";

export { buildDeterministicTurnId } from "@/chat/state/turn-id";

// ---------------------------------------------------------------------------
// Turn errors
// ---------------------------------------------------------------------------

/**
 * Queue-worker yield routing: respond.ts returns a suspended AgentRunOutcome
 * and the Slack executor raises this at the worker boundary so the lease owner
 * requeues the conversation.
 */
export class CooperativeTurnYieldError extends Error {
  readonly code = "cooperative_turn_yield";

  constructor(message = "Agent turn yielded at a safe boundary") {
    super(message);
    this.name = "CooperativeTurnYieldError";
  }
}

export function isCooperativeTurnYieldError(
  error: unknown,
): error is CooperativeTurnYieldError {
  return error instanceof CooperativeTurnYieldError;
}

/** Error indicating durable turn input could not be committed by the worker owner. */
export class TurnInputCommitLostError extends Error {
  readonly code = "turn_input_commit_lost";

  constructor(message = "Turn input commit lost its durable owner") {
    super(message);
    this.name = "TurnInputCommitLostError";
  }
}

/** Return whether an error means the durable worker lost input ownership. */
export function isTurnInputCommitLostError(
  error: unknown,
): error is TurnInputCommitLostError {
  return error instanceof TurnInputCommitLostError;
}

/** Error indicating durable turn input should stay pending for a later worker. */
export class TurnInputDeferredError extends Error {
  readonly code = "turn_input_deferred";

  constructor(message = "Turn input is deferred until the active resume ends") {
    super(message);
    this.name = "TurnInputDeferredError";
  }
}

/** Return whether an error means the durable worker should redeliver input later. */
export function isTurnInputDeferredError(
  error: unknown,
): error is TurnInputDeferredError {
  return error instanceof TurnInputDeferredError;
}

// ---------------------------------------------------------------------------
// Turn lifecycle mutations
// ---------------------------------------------------------------------------

/** Mark a turn as the active turn in conversation state. */
export function startActiveTurn(args: {
  conversation: ThreadConversationState;
  nextTurnId: string;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = args.nextTurnId;
  args.updateConversationStats(args.conversation);
}

function clearActiveTurn(
  conversation: ThreadConversationState,
  sessionId?: string,
): void {
  if (!sessionId || conversation.processing.activeTurnId === sessionId) {
    conversation.processing.activeTurnId = undefined;
  }
}

/**
 * Close the active turn without marking a Pi session reusable for future
 * history. Use this for auth handoffs and recovery replies that end the live
 * turn but do not produce a completed Pi session.
 */
export function markTurnClosed(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  sessionId?: string;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  clearActiveTurn(args.conversation, args.sessionId);
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}

/**
 * Mark a turn as completed after final reply delivery succeeds.
 */
export function markTurnCompleted(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  sessionId: string;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  clearActiveTurn(args.conversation, args.sessionId);
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}

/**
 * Mark a turn as failed when execution or final user-visible reply delivery
 * cannot be completed. If `sessionId` is provided, `activeTurnId` is only
 * cleared when it still matches the failing turn.
 */
export function markTurnFailed(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  sessionId?: string;
  userMessageId?: string;
  markConversationMessage: (
    conversation: ThreadConversationState,
    messageId: string | undefined,
    patch: { replied?: boolean; skippedReason?: string },
  ) => void;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  clearActiveTurn(args.conversation, args.sessionId);
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "reply failed",
  });
  args.updateConversationStats(args.conversation);
}
