// A queue provider that keeps its messages in memory and delivers them only
// when the test asks. It follows the production contract: a mounted
// `QueueConsumer` gets each payload with its metadata, a throw goes through
// `consumer.retry()`, and an idempotency key drops a second send. Delays use
// the queue's own clock, which moves only through `advanceTime`.
import { randomUUID } from "node:crypto";
import type {
  QueueConsumer,
  QueueProvider,
  QueueSendOptions,
} from "@/chat/queue/provider";

// A run that delivers more than this many messages is a loop, not a drain.
const DEFAULT_MAX_DELIVERIES = 100;

/** One message that the in-process queue holds or has delivered. */
export interface QueuedMessage {
  id: string;
  topic: string;
  payload: unknown;
  idempotencyKey?: string;
  /** The delay of the send, in seconds. */
  delaySeconds?: number;
  /** The number of deliveries so far. */
  deliveryCount: number;
  /** True when the queue's clock has passed the message's delay. */
  due: boolean;
}

/** A queue provider whose deliveries the test drives. */
export interface InProcessQueue extends QueueProvider {
  /** Takes the messages of the consumer's topic. One consumer per topic. */
  mount(consumer: QueueConsumer): void;
  /** Messages that wait for a delivery, in send order. */
  pending(topic?: string): QueuedMessage[];
  /** Messages whose last delivery finished or was acknowledged, in order. */
  delivered(topic?: string): QueuedMessage[];
  /**
   * Delivers the first due message of the topic to its consumer. Returns
   * `undefined` when no message is due.
   */
  deliverNext(topic: string): Promise<QueuedMessage | undefined>;
  /**
   * Delivers due messages of the topic until none is left, and returns how
   * many it delivered. Throws when it would deliver more than
   * `maxDeliveries`.
   */
  runUntilIdle(
    topic: string,
    options?: { maxDeliveries?: number },
  ): Promise<number>;
  /** Moves the queue's clock forward, so delayed messages come due. */
  advanceTime(seconds: number): void;
  /** Puts a delivered message back, due now, as a lost acknowledgement does. */
  redeliver(messageId: string): void;
  /** Removes a pending message without a delivery, as a lost message is. */
  drop(messageId: string): void;
}

interface StoredMessage {
  id: string;
  topic: string;
  payload: unknown;
  idempotencyKey?: string;
  delaySeconds?: number;
  createdAt: Date;
  dueAtSeconds: number;
  deliveryCount: number;
}

/** Creates an empty in-process queue with its clock at zero. */
export function createInProcessQueue(): InProcessQueue {
  const consumers = new Map<string, QueueConsumer>();
  const pendingMessages: StoredMessage[] = [];
  const deliveredMessages: StoredMessage[] = [];
  const sentKeys = new Set<string>();
  let nowSeconds = 0;
  // The last error that a consumer threw, for the error of a run that loops.
  let lastError: unknown;

  function view(message: StoredMessage): QueuedMessage {
    return {
      id: message.id,
      topic: message.topic,
      payload: message.payload,
      ...(message.idempotencyKey !== undefined && {
        idempotencyKey: message.idempotencyKey,
      }),
      ...(message.delaySeconds !== undefined && {
        delaySeconds: message.delaySeconds,
      }),
      deliveryCount: message.deliveryCount,
      due: message.dueAtSeconds <= nowSeconds,
    };
  }

  function onTopic(messages: StoredMessage[], topic?: string) {
    return messages
      .filter((message) => topic === undefined || message.topic === topic)
      .map(view);
  }

  function take(list: StoredMessage[], messageId: string): StoredMessage {
    const index = list.findIndex((message) => message.id === messageId);
    if (index === -1) {
      throw new Error(`No such queue message: ${messageId}`);
    }
    return list.splice(index, 1)[0]!;
  }

  /** The index of the first pending message of the topic that is due. */
  function firstDue(topic: string): number | undefined {
    const index = pendingMessages.findIndex(
      (message) =>
        message.topic === topic && message.dueAtSeconds <= nowSeconds,
    );
    return index === -1 ? undefined : index;
  }

  async function deliverNext(topic: string) {
    const consumer = consumers.get(topic);
    if (!consumer) {
      throw new Error(`No consumer is mounted on ${topic}`);
    }
    const index = firstDue(topic);
    if (index === undefined) {
      return undefined;
    }
    const message = pendingMessages.splice(index, 1)[0]!;
    message.deliveryCount += 1;
    const metadata = {
      consumerGroup: consumer.consumerGroup,
      createdAt: message.createdAt,
      deliveryCount: message.deliveryCount,
      messageId: message.id,
      topicName: topic,
    };
    try {
      await consumer.handler(message.payload, metadata);
      deliveredMessages.push(message);
    } catch (error) {
      lastError = error;
      if (consumer.retry(error, metadata)?.acknowledge) {
        deliveredMessages.push(message);
      } else {
        // Kept for a redelivery, at the head of the topic.
        pendingMessages.splice(index, 0, message);
      }
    }
    return view(message);
  }

  return {
    messagingSystem: "in_process",
    send: (topic: string, payload: unknown, options: QueueSendOptions = {}) => {
      const { delaySeconds, idempotencyKey } = options;
      if (idempotencyKey !== undefined) {
        if (sentKeys.has(idempotencyKey)) {
          return Promise.resolve({});
        }
        sentKeys.add(idempotencyKey);
      }
      const id = randomUUID();
      pendingMessages.push({
        id,
        topic,
        payload,
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(delaySeconds !== undefined && { delaySeconds }),
        createdAt: new Date(),
        dueAtSeconds: nowSeconds + (delaySeconds ?? 0),
        deliveryCount: 0,
      });
      return Promise.resolve({ messageId: id });
    },
    // The test delivers messages, so nothing pushes to a route.
    createCallback: () => () =>
      Promise.resolve(
        new Response("The in-process queue does not push messages", {
          status: 404,
        }),
      ),
    mount: (consumer) => {
      if (consumers.has(consumer.topic)) {
        throw new Error(`A consumer is already mounted on ${consumer.topic}`);
      }
      consumers.set(consumer.topic, consumer);
    },
    pending: (topic) => onTopic(pendingMessages, topic),
    delivered: (topic) => onTopic(deliveredMessages, topic),
    deliverNext,
    runUntilIdle: async (topic, options = {}) => {
      const maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES;
      for (let count = 0; ; count += 1) {
        if (firstDue(topic) === undefined) {
          return count;
        }
        if (count === maxDeliveries) {
          throw new Error(
            `${topic} was not idle after ${maxDeliveries} deliveries`,
            { cause: lastError },
          );
        }
        await deliverNext(topic);
      }
    },
    advanceTime: (seconds) => {
      nowSeconds += seconds;
    },
    redeliver: (messageId) => {
      const message = take(deliveredMessages, messageId);
      message.dueAtSeconds = nowSeconds;
      pendingMessages.push(message);
    },
    drop: (messageId) => {
      take(pendingMessages, messageId);
    },
  };
}
