import type { ThreadConversationState } from "@/chat/state/conversation";
import type { ReplyFileDelivery } from "@/chat/services/reply-delivery-plan";
import type { AssistantReply } from "@/chat/respond";

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

export type RetryableTurnReason = "mcp_auth_resume" | "turn_timeout_resume";

export interface RetryableTurnMetadata {
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

/** Mark a turn as completed and clear the active turn slot. */
export function markTurnCompleted(args: {
  conversation: ThreadConversationState;
  nowMs: number;
  updateConversationStats: (conversation: ThreadConversationState) => void;
}): void {
  args.conversation.processing.activeTurnId = undefined;
  args.conversation.processing.lastCompletedAtMs = args.nowMs;
  args.updateConversationStats(args.conversation);
}

/** Mark a turn as failed, clear the active slot, and annotate the user message. */
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

// ---------------------------------------------------------------------------
// Reply delivery resolution
// ---------------------------------------------------------------------------

/** Determine whether the thread reply should post and how files should attach. */
export function resolveReplyDelivery(args: {
  reply: AssistantReply;
  hasStreamedThreadReply: boolean;
}): {
  shouldPostThreadReply: boolean;
  attachFiles: ReplyFileDelivery;
} {
  const replyHasFiles = Boolean(
    args.reply.files && args.reply.files.length > 0,
  );
  const deliveryPlan = args.reply.deliveryPlan ?? {
    mode: args.reply.deliveryMode ?? "thread",
    postThreadText: (args.reply.deliveryMode ?? "thread") !== "channel_only",
    attachFiles: replyHasFiles
      ? args.hasStreamedThreadReply
        ? "followup"
        : "inline"
      : "none",
  };

  let attachFiles = replyHasFiles ? deliveryPlan.attachFiles : "none";
  if (attachFiles === "followup" && !args.hasStreamedThreadReply) {
    attachFiles = "inline";
  }

  return {
    shouldPostThreadReply: deliveryPlan.postThreadText,
    attachFiles,
  };
}
