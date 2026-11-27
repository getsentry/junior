import { PollingQueueClient, QueueClient } from "@vercel/queue";
import { getAppContext } from "@/app/context";
import { getChatConfig } from "@/chat/config";
import type { QueueConsumer, QueueProvider } from "@/chat/queue/provider";

type QueueClientOptions = ConstructorParameters<typeof QueueClient>[0];

function defaultQueueClientOptions(
  apiUrl: string | undefined,
  deploymentId: string | undefined,
): QueueClientOptions {
  if (apiUrl) {
    // A local queue server does not check tokens. Any token skips the Vercel
    // OIDC lookup, which fails outside Vercel.
    return {
      deploymentId: null,
      resolveBaseUrl: () => new URL(apiUrl),
      token: "local",
    };
  }
  if (deploymentId) {
    return {};
  }
  return { deploymentId: null };
}

interface VercelQueueClients {
  callbacks: QueueClient;
  send: QueueClient["send"];
}

/** The Vercel Queues clients of an app, and the config they were built from. */
export interface VercelQueueClientCache {
  current?: {
    apiUrl: string | undefined;
    deploymentId: string | undefined;
    clients: VercelQueueClients;
  };
}

function vercelQueueClients(
  apiUrl: string | undefined,
  deploymentId: string | undefined,
): VercelQueueClients {
  const options = defaultQueueClientOptions(apiUrl, deploymentId);
  const client = new QueueClient(options);
  if (!options?.resolveBaseUrl) {
    return { callbacks: client, send: client.send };
  }
  // With a local queue server: in development, `QueueClient.send` also
  // delivers in process, and warns for each message that has no registered
  // handler. The local server delivers instead, so send with
  // `PollingQueueClient`, which does not. `resolveBaseUrl` ignores the region.
  return {
    callbacks: client,
    send: new PollingQueueClient({ ...options, region: "iad1" }).send,
  };
}

// Build on first use, not at import, so env is read when the app runs.
// Build again when the config they were built from changes.
function getVercelQueueClients(): VercelQueueClients {
  const { apiUrl } = getChatConfig().queue;
  const deploymentId = getChatConfig().deployment.id;
  const cache = getAppContext().queueProvider;
  const { current } = cache;
  if (
    current &&
    current.apiUrl === apiUrl &&
    current.deploymentId === deploymentId
  ) {
    return current.clients;
  }
  const clients = vercelQueueClients(apiUrl, deploymentId);
  cache.current = { apiUrl, deploymentId, clients };
  return clients;
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
    const { messageId } = await getVercelQueueClients().send(
      topic,
      payload,
      options,
    );
    return messageId ? { messageId } : {};
  },
  // Use a client with the options above. The SDK's top-level
  // `handleCallback` uses a default client that ignores them.
  createCallback: (consumer) =>
    getVercelQueueClients().callbacks.handleCallback(consumer.handler, {
      retry: consumer.retry,
      ...visibility(consumer),
    }),
};
