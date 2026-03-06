export type RetryableTurnReason = "agent_turn_timeout_resume" | "subagent_task_deferred";

export class RetryableTurnError extends Error {
  readonly code = "retryable_turn";
  readonly reason: RetryableTurnReason;

  constructor(reason: RetryableTurnReason, message: string) {
    super(message);
    this.name = "RetryableTurnError";
    this.reason = reason;
  }
}

export function isRetryableTurnError(error: unknown, reason?: RetryableTurnReason): error is RetryableTurnError {
  if (!(error instanceof RetryableTurnError)) {
    return false;
  }
  if (!reason) {
    return true;
  }
  return error.reason === reason;
}
