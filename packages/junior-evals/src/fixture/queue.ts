/**
 * In-process conversation work queue for the agent test fixture.
 *
 * It replaces the Vercel Queue transport. Each sent message runs through the
 * app's worker after its delay, and messages can run at the same time, as on
 * Vercel. The fixture waits for every delivery before a call returns.
 */
import type {
  ConversationQueueMessage,
  ConversationQueueSendOptions,
  ConversationQueueSendResult,
  ConversationWorkQueue,
} from "@/chat/task-execution/queue";

type Consume = (
  message: ConversationQueueMessage,
  delivery: { messageId: string },
) => Promise<void>;

/** Queue that the fixture gives to `createApp({ conversationWorkQueue })`. */
export interface InProcessQueue extends ConversationWorkQueue {
  /** Bind the app's worker. `createApp()` calls this once. */
  connect(consume: Consume): ConversationWorkQueue;
  /** Deliveries that are waiting for their delay or running. */
  pending(): Promise<void>[];
  /** Hold deliveries until `release()`, so inputs form one mailbox batch. */
  hold(): void;
  release(): void;
  /** Failures from deliveries since the last call. */
  takeErrors(): unknown[];
  /** Stop starting deliveries. Running deliveries finish. */
  close(): void;
}

/** Create the fixture's in-process queue. */
export function createInProcessQueue(): InProcessQueue {
  let consume: Consume | undefined;
  let held = false;
  let closed = false;
  let nextMessageId = 0;
  const sentKeys = new Map<string, string>();
  const waiting: Array<() => void> = [];
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];

  const deliver = (
    message: ConversationQueueMessage,
    messageId: string,
    delayMs: number,
  ) => {
    const delivery = new Promise<void>((resolve) => {
      const start = () => {
        if (closed || !consume) {
          resolve();
          return;
        }
        consume(message, { messageId })
          .catch((error: unknown) => {
            errors.push(error);
          })
          .finally(resolve);
      };
      const schedule = () => setTimeout(start, delayMs);
      if (held) {
        waiting.push(schedule);
      } else {
        schedule();
      }
    });
    pending.add(delivery);
    void delivery.finally(() => pending.delete(delivery));
  };

  const queue: InProcessQueue = {
    async send(
      message: ConversationQueueMessage,
      options?: ConversationQueueSendOptions,
    ): Promise<ConversationQueueSendResult> {
      // Vercel Queues drop a repeated idempotency key within retention.
      const key = options?.idempotencyKey;
      const existing = key ? sentKeys.get(key) : undefined;
      if (existing) {
        return { messageId: existing };
      }
      nextMessageId += 1;
      const messageId = `in-process-${nextMessageId}`;
      if (key) {
        sentKeys.set(key, messageId);
      }
      deliver(message, messageId, Math.max(0, options?.delayMs ?? 0));
      return { messageId };
    },
    connect(next) {
      consume = next;
      return queue;
    },
    pending: () => [...pending],
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const schedule of waiting.splice(0)) {
        schedule();
      }
    },
    takeErrors: () => errors.splice(0),
    close() {
      closed = true;
      queue.release();
    },
  };
  return queue;
}
