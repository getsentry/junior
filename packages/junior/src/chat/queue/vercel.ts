import { createHash } from "node:crypto";
import { PollingQueueClient, QueueClient } from "@vercel/queue";
import type {
  QueueConsumer,
  QueueProvider,
  QueueSendOptions,
} from "@/chat/queue/provider";

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

function visibility(consumer: QueueConsumer) {
  return consumer.visibilityTimeoutSeconds === undefined
    ? {}
    : { visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds };
}

// Vercel Queues rejects an idempotency key over 256 characters. Keys built
// from nested ids, such as child agent reply ids, can be longer. Send such a
// key as its readable start, `:`, and the hash of the whole key, at exactly the
// limit. The hash is stable, so the same key still drops a second send.
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

function withBoundedIdempotencyKey(
  options: QueueSendOptions | undefined,
): QueueSendOptions | undefined {
  const key = options?.idempotencyKey;
  if (!key || key.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
    return options;
  }
  const digest = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH - digest.length - 1);
  return { ...options, idempotencyKey: `${prefix}:${digest}` };
}

/**
 * Build a queue provider backed by Vercel Queues. It builds its clients on the
 * first send or callback.
 */
export function createVercelQueueProvider(options: {
  apiUrl: string | undefined;
  deploymentId: string | undefined;
}): QueueProvider {
  let clients: VercelQueueClients | undefined;
  const getClients = (): VercelQueueClients =>
    (clients ??= vercelQueueClients(options.apiUrl, options.deploymentId));
  return {
    // OpenTelemetry has no well-known `messaging.system` value for Vercel
    // Queues.
    messagingSystem: "vercel_queue",
    send: async (topic, payload, sendOptions) => {
      const { messageId } = await getClients().send(
        topic,
        payload,
        withBoundedIdempotencyKey(sendOptions),
      );
      return messageId ? { messageId } : {};
    },
    // Use a client with the options above. The SDK's top-level
    // `handleCallback` uses a default client that ignores them.
    createCallback: (consumer) =>
      getClients().callbacks.handleCallback(consumer.handler, {
        retry: consumer.retry,
        ...visibility(consumer),
      }),
  };
}
