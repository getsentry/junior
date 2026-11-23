import { PollingQueueClient, QueueClient } from "@vercel/queue";
import { getChatConfig } from "@/chat/config";
import type { QueueConsumer, QueueProvider } from "@/chat/queue/provider";

type QueueClientOptions = ConstructorParameters<typeof QueueClient>[0];

function defaultQueueClientOptions(): QueueClientOptions {
  const { queue } = getChatConfig();
  const apiUrl = queue.provider === "vercel" ? queue.apiUrl : undefined;
  if (apiUrl) {
    // A local queue server does not check tokens. Any token skips the Vercel
    // OIDC lookup, which fails outside Vercel.
    return {
      deploymentId: null,
      resolveBaseUrl: () => new URL(apiUrl),
      token: "local",
    };
  }
  if (process.env["VERCEL_DEPLOYMENT_ID"]?.trim()) {
    return {};
  }
  return { deploymentId: null };
}

interface VercelQueueClients {
  callbacks: QueueClient;
  send: QueueClient["send"];
}

function vercelQueueClients(): VercelQueueClients {
  const options = defaultQueueClientOptions();
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

let clients: VercelQueueClients | undefined;

// Build on first use, not at import, so env is read when the app runs.
function getVercelQueueClients(): VercelQueueClients {
  clients ??= vercelQueueClients();
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
