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
let currentDeploymentClient: QueueClient | undefined;

// Build on first use, not at import, so env is read when the app runs.
function getVercelQueueClient(): QueueClient {
  client ??= new QueueClient(defaultQueueClientOptions());
  return client;
}

// A default client pins each message to the deployment that sent it. This
// client is unpinned, so its messages are not tied to an old deployment.
function getCurrentDeploymentQueueClient(): QueueClient {
  currentDeploymentClient ??= new QueueClient({ deploymentId: null });
  return currentDeploymentClient;
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
    const { currentDeployment, ...sendOptions } = options ?? {};
    const queueClient = currentDeployment
      ? getCurrentDeploymentQueueClient()
      : getVercelQueueClient();
    const { messageId } = await queueClient.send(topic, payload, sendOptions);
    return messageId ? { messageId } : {};
  },
  createCallback: (consumer) => {
    const options = { retry: consumer.retry, ...visibility(consumer) };
    return consumer.currentDeployment
      ? getCurrentDeploymentQueueClient().handleCallback(
          consumer.handler,
          options,
        )
      : handleCallback(consumer.handler, options);
  },
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
