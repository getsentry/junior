import type { JuniorToolContinuation } from "@/chat/tool-support/structured-result";

/** Signal that durable work remains and the host should re-enter this tool. */
export class UnfinishedToolError extends Error {
  readonly continuation: JuniorToolContinuation;

  constructor(continuation: JuniorToolContinuation) {
    super(continuation.reason ?? "Tool has unfinished work");
    this.name = "UnfinishedToolError";
    this.continuation = continuation;
  }
}
