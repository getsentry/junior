import { LockError } from "chat";
import { getStateAdapter } from "@/chat/state";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

type Logger = {
  error?: (message: string, data?: Record<string, unknown>) => void;
};

// Retries a Chat SDK operation that may throw LockError due to per-thread Redis lock contention.
//
// The SDK dedupes inbound messages by setting a `dedupe:<adapter>:<messageId>` key *before*
// attempting to acquire the thread lock. When the lock is held by another worker, the SDK
// throws LockError — but the dedup key is already set, so the message can never be retried
// through normal dispatch. This helper clears that dedup key on each LockError before retrying,
// giving the next attempt a clean slate.
//
// Exponential backoff: 1s, 2s, 4s.
export async function retryOnLockError(opts: {
  fn: () => Promise<void>;
  adapterName: string;
  messageId: string | undefined;
  threadId: string;
  logger?: Logger;
}): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await opts.fn();
      return;
    } catch (err) {
      if (!(err instanceof LockError)) {
        opts.logger?.error?.("Message processing error", { error: err, threadId: opts.threadId });
        return;
      }

      if (attempt >= MAX_ATTEMPTS) {
        opts.logger?.error?.("Message dropped after lock retries exhausted", {
          error: err,
          threadId: opts.threadId,
          attempts: attempt,
        });
        return;
      }

      // Best-effort: clear the dedup key so the SDK doesn't reject the message on retry.
      // If this fails (Redis transient error), we still retry — the SDK will re-set the key anyway.
      if (opts.messageId) {
        try {
          await getStateAdapter().delete(`dedupe:${opts.adapterName}:${opts.messageId}`);
        } catch {
          // ignored — dedup clear is best-effort
        }
      }

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
