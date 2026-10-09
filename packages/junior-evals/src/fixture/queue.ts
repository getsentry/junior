/**
 * In-process conversation work queue for the agent test fixture.
 *
 * It replaces the Vercel Queue transport. Each sent message runs through the
 * app's worker after its delay, and messages can run at the same time, as on
 * Vercel. The fixture waits for every delivery before a call returns.
 *
 * The worker also sends messages itself, for example to continue a turn that
 * stopped at its deadline. The queue knows such a message because the worker
 * sends it during a delivery.
 */
import { AsyncLocalStorage } from "node:async_hooks";
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
  /** When the last delivery was due to start, or 0 before the first one. */
  latestStartAtMs(): number;
  /** Hold deliveries until `release()`, so inputs form one mailbox batch. */
  hold(): void;
  release(): void;
  /**
   * Post an input of the test. A progress handler posts input during a
   * delivery, and the app can send a queue message for that input, as it does
   * for a stop. That message is not from the worker.
   */
  asInput<T>(post: () => Promise<T>): Promise<T>;
  /**
   * Called before a delivery starts when the worker sent its message. The
   * delivery waits until the hook finishes.
   */
  setRequeueHook(
    hook: ((conversationId: string) => Promise<void>) | undefined,
  ): void;
  /** The Conversation of each sent message, in send order. */
  sentConversationIds(): string[];
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
  let latestStartAtMs = 0;
  const sentKeys = new Map<string, string>();
  const waiting: Array<() => void> = [];
  const pending = new Set<Promise<void>>();
  const errors: unknown[] = [];
  const sentConversationIds: string[] = [];
  // Set while the worker runs a delivery.
  const inDelivery = new AsyncLocalStorage<true>();
  let requeueHook: ((conversationId: string) => Promise<void>) | undefined;

  const deliver = (
    message: ConversationQueueMessage,
    messageId: string,
    delayMs: number,
    fromWorker: boolean,
  ) => {
    latestStartAtMs = Math.max(latestStartAtMs, Date.now() + delayMs);
    const delivery = new Promise<void>((resolve) => {
      const start = async () => {
        if (fromWorker) await requeueHook?.(message.conversationId);
        const run = consume;
        if (closed || !run) return;
        await inDelivery.run(true, () => run(message, { messageId }));
      };
      const startAndSettle = () => {
        start()
          .catch((error: unknown) => {
            errors.push(error);
          })
          .finally(resolve);
      };
      const schedule = () => setTimeout(startAndSettle, delayMs);
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
      sentConversationIds.push(message.conversationId);
      nextMessageId += 1;
      const messageId = `in-process-${nextMessageId}`;
      if (key) {
        sentKeys.set(key, messageId);
      }
      deliver(
        message,
        messageId,
        Math.max(0, options?.delayMs ?? 0),
        inDelivery.getStore() === true,
      );
      return { messageId };
    },
    connect(next) {
      consume = next;
      return queue;
    },
    pending: () => [...pending],
    latestStartAtMs: () => latestStartAtMs,
    hold() {
      held = true;
    },
    release() {
      held = false;
      for (const schedule of waiting.splice(0)) {
        schedule();
      }
    },
    asInput: (post) => inDelivery.exit(post),
    setRequeueHook(hook) {
      requeueHook = hook;
    },
    sentConversationIds: () => [...sentConversationIds],
    takeErrors: () => errors.splice(0),
    close() {
      closed = true;
      queue.release();
    },
  };
  return queue;
}
