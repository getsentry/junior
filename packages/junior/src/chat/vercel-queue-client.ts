import { QueueClient } from "@vercel/queue";

type QueueClientOptions = ConstructorParameters<typeof QueueClient>[0];

function defaultQueueClientOptions(): QueueClientOptions {
  if (process.env.VERCEL_DEPLOYMENT_ID?.trim()) {
    return {};
  }
  return { deploymentId: null };
}

/** Create a Vercel Queue client that also works in local and eval runtimes. */
export function createVercelQueueClient(): QueueClient {
  return new QueueClient(defaultQueueClientOptions());
}
