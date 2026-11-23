// Module overview: pushes local queue messages to the app's callback routes.
//
// In production, Vercel Queues calls the app's callback routes. The local
// queue delivery does the same for `JUNIOR_QUEUE_PROVIDER=local`: it takes
// each pg-boss job and POSTs it to the route of its topic. A 2xx response
// completes the job. Any other response or error retries it with backoff.
import type { Job } from "pg-boss";
import { mapBounded } from "@/chat/fan-out";
import {
  createLocalQueue,
  LOCAL_QUEUE_HEADERS,
  startLocalJobs,
  type LocalJobData,
} from "@/chat/queue/local-jobs";
import type { QueueConsumer } from "@/chat/queue/provider";

// The Vercel Queues SDK uses this when a consumer sets no visibility timeout.
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DELIVERIES_PER_TOPIC = 4;
const POLL_SECONDS = 2;

/** Running local queue delivery. */
export interface LocalQueueDelivery {
  /** Stop taking messages, wait for running ones, and disconnect. */
  close(): Promise<void>;
}

/**
 * Push local queue messages for these consumers to their callback routes
 * until `close()`.
 */
export async function startLocalQueueDelivery(args: {
  consumers: QueueConsumer[];
  /** Send one request to the app, the way Vercel Queues calls it. */
  fetch(request: Request): Promise<Response>;
  /** The callback route of each topic. */
  routes: Array<{ route: string; topic: string }>;
}): Promise<LocalQueueDelivery> {
  const routeByTopic = new Map(args.routes.map((r) => [r.topic, r.route]));
  const queues = args.consumers.map((consumer) => {
    const route = routeByTopic.get(consumer.topic);
    if (route === undefined) {
      throw new Error(`No queue callback route for topic ${consumer.topic}`);
    }
    return { consumer, route };
  });

  const boss = await startLocalJobs({ deliver: true });
  try {
    await mapBounded(queues, async ({ consumer, route }) => {
      await createLocalQueue(boss, consumer.topic);
      // A job whose heartbeat stops, such as when the dev server
      // restarts, is retried after this time, like a Vercel message whose
      // visibility timeout ends.
      await boss.updateQueue(consumer.topic, {
        heartbeatSeconds: Math.ceil(
          consumer.visibilityTimeoutSeconds ??
            DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
        ),
      });
      await boss.work(
        consumer.topic,
        {
          localConcurrency: DELIVERIES_PER_TOPIC,
          // NOTIFY wakes delivery only for a new job. Delayed and retried
          // jobs wait for the next poll.
          notifyPollingIntervalSeconds: POLL_SECONDS,
          pollingIntervalSeconds: POLL_SECONDS,
        },
        async ([job]: Job<LocalJobData>[]) => {
          if (job) {
            await deliver(args.fetch, route, job);
          }
        },
      );
    });
  } catch (error) {
    await boss.stop({ graceful: false });
    throw error;
  }
  return { close: () => boss.stop({ graceful: true }) };
}

async function deliver(
  fetch: (request: Request) => Promise<Response>,
  route: string,
  job: Job<LocalJobData>,
): Promise<void> {
  const { payload, retentionSeconds, sentAt } = job.data;
  if (
    retentionSeconds !== undefined &&
    Date.now() - sentAt > retentionSeconds * 1000
  ) {
    return;
  }
  const response = await fetch(
    new Request(new URL(route, "http://localhost"), {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        [LOCAL_QUEUE_HEADERS.createdAt]: new Date(sentAt).toISOString(),
        [LOCAL_QUEUE_HEADERS.deliveryCount]: String(job.retryCount + 1),
        [LOCAL_QUEUE_HEADERS.messageId]: job.id,
      },
      method: "POST",
    }),
  );
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error(`Queue callback ${route} returned ${response.status}`);
  }
}
