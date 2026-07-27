import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";

export interface LocalConversationWork {
  drain(): Promise<void>;
  queue: ConversationWorkQueue;
}

/**
 * Run local conversation work in this process and wait for every accepted wake.
 *
 * Delayed and follow-up wakes remain tracked so CLI shutdown cannot abandon
 * child work that was accepted while an earlier wake was running.
 */
export function createLocalConversationWork(
  processMessage: (message: ConversationQueueMessage) => Promise<void>,
): LocalConversationWork {
  const pending = new Set<Promise<void>>();
  let firstError: unknown;

  function schedule(
    message: ConversationQueueMessage,
    options?: ConversationQueueSendOptions,
  ): void {
    const delayMs = Math.max(0, options?.delayMs ?? 0);
    let work: Promise<void>;
    work = (async () => {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
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

  return {
    queue: {
      async send(message, options) {
        schedule(message, options);
      },
    },
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
