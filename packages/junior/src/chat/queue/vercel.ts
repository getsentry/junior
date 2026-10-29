import {
  QueueClient,
  handleCallback,
  registerDevConsumer,
} from "@vercel/queue";
import type { QueueConsumer, QueueProvider } from "@/chat/queue/provider";

type QueueClientOptions = ConstructorParameters<typeof QueueClient>[0];

function defaultQueueClientOptions(): QueueClientOptions {
  if (process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
    return {};
  }
  return { deploymentId: null };
}

let client: QueueClient | undefined;

// Build on first use, not at import, so env is read when the app runs.
function getVercelQueueClient(): QueueClient {
  client ??= new QueueClient(defaultQueueClientOptions());
  return client;
}

function visibility(consumer: QueueConsumer) {
  return consumer.visibilityTimeoutSeconds === undefined
    ? {}
    : { visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds };
}

/** Queue provider backed by Vercel Queues. */
export const vercelQueueProvider: QueueProvider = {
  // OpenTelemetry has no well-known `messaging.system` value for Vercel Queues.
  messagingSystem: "vercel_queue",
  send: async (topic, payload, options) => {
    const { messageId } = await getVercelQueueClient().send(
      topic,
      payload,
      options,
    );
    return messageId ? { messageId } : {};
  },
  createCallback: (consumer) =>
    handleCallback(consumer.handler, {
      retry: consumer.retry,
      ...visibility(consumer),
    }),
  registerDevConsumer: (consumer) =>
    registerDevConsumer({
      client: getVercelQueueClient(),
      consumerGroup: consumer.consumerGroup,
      handler: consumer.handler,
      retry: consumer.retry,
      topic: consumer.topic,
      ...visibility(consumer),
    }),
};
