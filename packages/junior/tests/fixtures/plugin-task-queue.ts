/**
 * In-process plugin task queue for `createApp({ pluginTaskQueue })`. It
 * keeps each started task until the test delivers it, so a test controls
 * the time of each delivery, as the queue's delay and backoff would.
 */
import type { createApp } from "@/app";
import type {
  PluginTaskQueueMessage,
  PluginTaskSendOptions,
} from "@/chat/plugins/task-queue";

type PluginTaskQueueOption = NonNullable<
  NonNullable<Parameters<typeof createApp>[0]>["pluginTaskQueue"]
>;

interface QueuedTask {
  deliveries: number;
  done: boolean;
  message: PluginTaskQueueMessage;
  options: PluginTaskSendOptions | undefined;
}

/** Create the queue. Pass `pluginTaskQueue` to `createApp`. */
export function createPluginTaskQueueTestAdapter() {
  let consume: Parameters<PluginTaskQueueOption>[0] | undefined;
  const sent: QueuedTask[] = [];
  const keys = new Set<string>();
  const pluginTaskQueue: PluginTaskQueueOption = (next) => {
    consume = next;
    return {
      async send(message, options) {
        // The queue drops a second send with the same key.
        const key = options?.idempotencyKey;
        if (key && keys.has(key)) return;
        if (key) keys.add(key);
        sent.push({ deliveries: 0, done: false, message, options });
      },
    };
  };
  return {
    pluginTaskQueue,
    /** The tasks that were sent, oldest first, with their send options. */
    sent: () => sent.map(({ message, options }) => ({ message, options })),
    /**
     * Deliver each task that is not done once. A task that throws stays
     * for its next delivery. Return the number of deliveries.
     */
    async deliver(): Promise<number> {
      if (!consume) throw new Error("Create the app with this queue first");
      const due = sent.filter((task) => !task.done);
      for (const task of due) {
        task.deliveries += 1;
        try {
          await consume(task.message, { deliveryCount: task.deliveries });
          task.done = true;
        } catch {
          // The queue delivers it again after its backoff.
        }
      }
      return due.length;
    },
  };
}
