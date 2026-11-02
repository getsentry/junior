/** A Slack input that Junior could not fully save and wake a worker for. */
export class SlackEventPersistenceError extends Error {
  override readonly cause: unknown;
  /** True when the mailbox kept the input and only the queue send failed. */
  readonly saved: boolean;

  constructor(cause: unknown, saved: boolean) {
    super("Slack event durable persistence failed");
    this.name = "SlackEventPersistenceError";
    this.cause = cause;
    this.saved = saved;
  }
}
