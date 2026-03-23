export type DeferredThreadMessageReason = "active_turn" | "thread_locked";

export class DeferredThreadMessageError extends Error {
  readonly code = "deferred_thread_message";
  readonly reason: DeferredThreadMessageReason;

  constructor(
    reason: DeferredThreadMessageReason,
    threadId: string,
    details?: {
      activeTurnId?: string;
      currentTurnId?: string;
    },
  ) {
    if (reason === "thread_locked") {
      super(
        `Queue message deferred because thread ${threadId} is already locked`,
      );
    } else {
      super(
        `Queue message deferred for thread ${threadId} because activeTurnId=${
          details?.activeTurnId ?? "unknown"
        } is still in progress for currentTurnId=${
          details?.currentTurnId ?? "unknown"
        }`,
      );
    }
    this.name = "DeferredThreadMessageError";
    this.reason = reason;
  }
}

export function isDeferredThreadMessageError(
  error: unknown,
  reason?: DeferredThreadMessageReason,
): error is DeferredThreadMessageError {
  if (!(error instanceof DeferredThreadMessageError)) {
    return false;
  }
  if (!reason) {
    return true;
  }
  return error.reason === reason;
}
