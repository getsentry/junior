import type { ThreadConversationState } from "@/chat/state/conversation";
import type {
  AuthorizationPauseDisposition,
  AuthorizationPauseKind,
} from "@/chat/services/auth-pause";
import type { TurnThinkingSelection } from "@/chat/services/turn-thinking-level";
import type { AgentTurnUsage } from "@/chat/usage";

// ---------------------------------------------------------------------------
// Turn ID
// ---------------------------------------------------------------------------

/** Build a stable turn identifier from a message ID. */
export function buildDeterministicTurnId(messageId: string): string {
  const sanitized = messageId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `turn_${sanitized}`;
}

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
  checkpointVersion?: number;
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

/**
 * Mark a turn as completed after the runtime has durably accepted the final
 * user-visible reply for delivery.
 */
export function markTurnCompleted(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = undefined;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}

/**
 * Mark a turn as failed when execution or final user-visible reply delivery
 * cannot be completed.
 */
export function markTurnFailed(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  userMessageId?: string;
  markConversationMessage: (
    conversation: ThreadConversationState,
    messageId: string | undefined,
    patch: { replied?: boolean; skippedReason?: string },
  ) => void;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = undefined;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.markConversationMessage(args.conversation, args.userMessageId, {
    replied: false,
    skippedReason: "reply failed",
  });
  args.updateConversationStats(args.conversation);
}
