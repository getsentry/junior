import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";

/**
 * Run local conversation work in this process and wait for every accepted wake.
 *
 * Wakes start on a later event-loop turn so their producer can persist the
 * accepted marker first. Idempotent, delayed, and follow-up wakes remain
 * tracked so CLI shutdown cannot abandon accepted child work.
 */
export function createLocalConversationWork(
  processMessage: (message: ConversationQueueMessage) => Promise<void>,
) {
  const acceptedWakeIds = new Map<string, string>();
  const pending = new Set<Promise<void>>();
  let firstError: unknown;
  let nextWakeId = 1;

  function schedule(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): void {
    const delayMs = Math.max(0, options?.delayMs ?? 0);
    let work: Promise<void>;
    work = (async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      await processMessage(message);
    })()
      .catch((error: unknown) => {
        firstError ??= error;
      })
      .finally(() => {
        pending.delete(work);
      });
    pending.add(work);
  }

  const queue: ConversationWorkQueue = {
    async send(message, options) {
      const idempotencyKey = options?.idempotencyKey;
      const acceptedWakeId = idempotencyKey
        ? acceptedWakeIds.get(idempotencyKey)
        : undefined;
      if (acceptedWakeId) {
        return { messageId: acceptedWakeId };
      }
      const messageId = `local-conversation-work:${nextWakeId}`;
      nextWakeId += 1;
      if (idempotencyKey) {
        acceptedWakeIds.set(idempotencyKey, messageId);
      }
      schedule(message, options);
      return { messageId };
    },
  };

  return {
    queue,
    async drain() {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
      if (firstError !== undefined) {
        const error = firstError;
        firstError = undefined;
        throw error;
      }
    },
  };
}
