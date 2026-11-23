import type { Nitro } from "nitro/types";
import { readQueueConfig } from "@/chat/queue/config";
import { startLocalVercelQueueServer } from "@/chat/queue/local-server";
import { queueCallbackRoutes } from "@/chat/queue/routes";

// Each topic has one consumer, so one group name serves every topic.
const LOCAL_CONSUMER_GROUP = "local";

/**
 * Start a local Vercel Queues server for `nitro dev`, and point the app's
 * `vercel` queue provider at it. The server pushes each message to its
 * callback route on the dev server, as Vercel does in production.
 *
 * Nitro runs modules in its main process, which outlives each reload of the
 * app worker, so queued messages survive an app reload. A Nitro restart
 * loses them. Does nothing when the app uses another queue provider or
 * `JUNIOR_QUEUE_API_URL` names another server.
 */
export async function startDevQueue(nitro: Nitro): Promise<void> {
  const queue = readQueueConfig(process.env);
  if (queue.provider !== "vercel" || queue.apiUrl) {
    return;
  }
  // The port that Nitro's dev server listens on, unless `nitro dev --port`
  // overrides it.
  const port =
    nitro.options.devServer.port ?? (process.env["PORT"]?.trim() || 3000);
  const appUrl = `http://localhost:${port}`;
  const server = await startLocalVercelQueueServer({
    consumers: queueCallbackRoutes().map(({ route, topic }) => ({
      consumerGroup: LOCAL_CONSUMER_GROUP,
      topic,
      url: new URL(route, appUrl).href,
    })),
  });
  // Each app worker copies `process.env` when it starts.
  process.env["JUNIOR_QUEUE_API_URL"] = server.url.href;
  nitro.logger.info(`Local Vercel Queues server: ${server.url.href}`);
  // A change to the Nitro config closes this instance and runs modules again.
  nitro.hooks.hook("close", async () => {
    delete process.env["JUNIOR_QUEUE_API_URL"];
    await server.close();
  });
}
