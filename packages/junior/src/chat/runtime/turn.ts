import type { ThreadConversationState } from "@/chat/state/conversation";
import type {
  AuthorizationPauseDisposition,
  AuthorizationPauseKind,
} from "@/chat/services/auth-pause";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";

export { buildDeterministicTurnId } from "@/chat/state/turn-id";

// ---------------------------------------------------------------------------
// Turn errors
// ---------------------------------------------------------------------------

export type RetryableTurnReason =
  | "mcp_auth_resume"
  | "plugin_auth_resume"
  | "turn_timeout_resume";

export interface RetryableTurnMetadata {
  authDisposition?: AuthorizationPauseDisposition;
  authDurationMs?: number;
  authKind?: AuthorizationPauseKind;
  authProvider?: string;
  authThinkingLevel?: TurnThinkingSelection["thinkingLevel"];
  authUsage?: AgentTurnUsage;
  version?: number;
  conversationId?: string;
  sessionId?: string;
  sliceId?: number;
}

/** Error indicating the turn can be retried (timeout or auth pause). */
export class RetryableTurnError extends Error {
  readonly code = "retryable_turn";
  readonly metadata?: RetryableTurnMetadata;
  readonly reason: RetryableTurnReason;

  constructor(
    reason: RetryableTurnReason,
    message: string,
    metadata?: RetryableTurnMetadata,
  ) {
    super(message);
    this.name = "RetryableTurnError";
    this.reason = reason;
    this.metadata = metadata;
  }
}

export function isRetryableTurnError(
  error: unknown,
  reason?: RetryableTurnReason,
): error is RetryableTurnError {
  if (!(error instanceof RetryableTurnError)) {
    return false;
  }
  if (!reason) {
    return true;
  }
  return error.reason === reason;
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
