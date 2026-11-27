import type { TurnFailure } from "@/core/turn/state";

/**
 * Thrown by host code that runs in a step, such as a tool hook, the tools
 * builder or the prompt layout, to end the Turn as failed now. Core stores
 * `failure` and does not run the step again. Any other error makes the queue
 * retry the step. An optional loader's errors never fail the step, so one
 * from an optional loader does nothing.
 */
export class TurnFailedError extends Error {
  readonly failure: TurnFailure;

  constructor(message: string, failure: TurnFailure) {
    super(message);
    this.name = "TurnFailedError";
    this.failure = failure;
  }
}
