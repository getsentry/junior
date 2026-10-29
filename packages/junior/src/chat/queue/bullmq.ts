import { createHash } from "node:crypto";
import type { Job, Queue, Worker } from "bullmq";
import { getChatConfig } from "@/chat/config";
import { logException, logInfo, logWarn } from "@/chat/logging";
import type {
  QueueConsumer,
  QueueMessageMetadata,
  QueueProvider,
  QueueWorker,
} from "@/chat/queue/provider";

// Module overview: a queue provider for local development, backed by BullMQ
// on Redis, so `pnpm dev` needs no Vercel Queues access. Deployed apps use
// the Vercel provider.
//
// The Nitro process only sends jobs. The dev server starts one separate
// worker process that calls `startWorker()` and pulls the jobs. `close()`
// on that worker releases every BullMQ and Redis resource of its process.
//
// `bullmq` and `redis` are optional peer dependencies. Only dev installs
// need them.

interface JobData {
  payload: unknown;
  retentionSeconds?: number;
}

type BullMq = typeof import("bullmq");
type RedisConnection = ReturnType<BullMq["createNodeRedisClient"]>;

// Durable state owns the real attempt limit for conversation work
// (`maxDeliveries: null`). This cap only stops a message that always fails
// from looping for ever in dev.
const MAX_ATTEMPTS = 50;
const MAX_BACKOFF_MS = 30_000;
// Running jobs get this long to finish when the worker stops. After that,
// BullMQ stops waiting. Their locks expire, and the jobs run again later.
const SHUTDOWN_GRACE_MS = 10_000;
// A job id drops a second send only while BullMQ still stores the first job.
// So this is the dedupe window for idempotency keys.
const COMPLETED_JOB_AGE_SECONDS = 60 * 60;
const FAILED_JOB_AGE_SECONDS = 24 * 60 * 60;

let loaded:
  | Promise<{ bullmq: BullMq; connection: RedisConnection }>
  | undefined;
const queues = new Map<string, Queue<JobData>>();

/**
 * Import a module by a name held in a variable.
 *
 * Bundlers follow a literal `import("bullmq")` and put BullMQ into the
 * production server, even though production never selects this provider.
 * Node resolves this import when the app runs instead.
 */
function importAtRuntime(specifier: string): Promise<unknown> {
  return import(/* @vite-ignore */ specifier);
}

function bullmqConfig() {
  const config = getChatConfig().queue;
  if (config.provider !== "bullmq") {
    throw new Error("The BullMQ queue provider is not configured");
  }
  return config;
}

/** Load BullMQ and one shared Redis client the first time they are needed. */
function load() {
  loaded ??= (async () => {
    const [bullmq, redis] = (await Promise.all([
      importAtRuntime("bullmq"),
      importAtRuntime("redis"),
    ]).catch((error: unknown) => {
      throw new Error(
        "JUNIOR_QUEUE_PROVIDER=bullmq needs the bullmq and redis packages installed",
        { cause: error },
      );
    })) as [BullMq, typeof import("redis")];
    const client = redis.createClient({ url: bullmqConfig().redisUrl });
    await client.connect();
    return { bullmq, connection: bullmq.createNodeRedisClient(client) };
  })();
  return loaded;
}

async function getQueue(topic: string): Promise<Queue<JobData>> {
  const { bullmq, connection } = await load();
  let queue = queues.get(topic);
  if (!queue) {
    queue = new bullmq.Queue<JobData>(topic, {
      connection,
    });
    queues.set(topic, queue);
  }
  return queue;
}

/** BullMQ job ids must not contain ":", and Junior's keys do. */
function toJobId(idempotencyKey: string): string {
  return `k-${createHash("sha256").update(idempotencyKey).digest("base64url")}`;
}

function metadataFor(
  job: Job<JobData>,
  consumer: QueueConsumer,
): QueueMessageMetadata {
  return {
    consumerGroup: consumer.consumerGroup,
    createdAt: new Date(job.timestamp),
    deliveryCount: job.attemptsMade + 1,
    messageId: job.id ?? "",
    topicName: consumer.topic,
  };
}

async function processJob(
  job: Job<JobData>,
  consumer: QueueConsumer,
): Promise<void> {
  const { payload, retentionSeconds } = job.data;
  if (
    retentionSeconds !== undefined &&
    Date.now() - job.timestamp > retentionSeconds * 1000
  ) {
    return;
  }
  const metadata = metadataFor(job, consumer);
  try {
    await consumer.handler(payload, metadata);
  } catch (error) {
    if (consumer.retry(error, metadata)?.acknowledge) {
      return;
    }
    throw error;
  }
}

/** Wait for running jobs, but stop waiting after the grace period. */
async function closeWorker(worker: Worker<JobData>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const graceful = worker.close().then(() => true);
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS);
  });
  const finished = await Promise.race([graceful, timedOut]);
  clearTimeout(timer);
  if (!finished) {
    logWarn("queue.bullmq.worker.shutdown_timeout", {
      "messaging.destination.name": worker.name,
    });
    await worker.close(true);
  }
}

/** Release the queues and the Redis client of this process. */
async function closeConnections(): Promise<void> {
  const current = loaded;
  loaded = undefined;
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close()));
  if (current) {
    const { connection } = await current;
    await connection.quit();
  }
}

/** Start one BullMQ worker for each consumer in this process. */
async function startWorker(consumers: QueueConsumer[]): Promise<QueueWorker> {
  const { bullmq, connection } = await load();
  const concurrency = bullmqConfig().workerConcurrency;
  const workers = consumers.map((consumer) => {
    const worker = new bullmq.Worker<JobData>(
      consumer.topic,
      (job) => processJob(job, consumer),
      {
        concurrency,
        connection,
        // BullMQ renews this lock while the job runs. Unlike Vercel Queues,
        // a running job is not sent again when the time runs out.
        ...(consumer.visibilityTimeoutSeconds !== undefined && {
          lockDuration: consumer.visibilityTimeoutSeconds * 1000,
        }),
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            Math.min(1000 * 2 ** (attemptsMade - 1), MAX_BACKOFF_MS),
        },
      },
    );
    worker.on("error", (error) => {
      logException(error, "queue.bullmq.worker.exception", {
        "messaging.destination.name": consumer.topic,
      });
    });
    return worker;
  });
  logInfo("queue.bullmq.worker.started", {
    "app.queue.worker_concurrency": concurrency,
    "messaging.destination.names": consumers.map((consumer) => consumer.topic),
  });
  return {
    close: async () => {
      await Promise.all(workers.map((worker) => closeWorker(worker)));
      await closeConnections();
    },
  };
}

/** Queue provider backed by BullMQ, for local development only. */
export const bullmqQueueProvider: QueueProvider = {
  messagingSystem: "bullmq",
  send: async (topic, payload, options = {}) => {
    const queue = await getQueue(topic);
    const job = await queue.add(
      topic,
      { payload, retentionSeconds: options.retentionSeconds },
      {
        attempts: MAX_ATTEMPTS,
        backoff: { type: "custom" },
        delay: options.delaySeconds ? options.delaySeconds * 1000 : undefined,
        jobId: options.idempotencyKey
          ? toJobId(options.idempotencyKey)
          : undefined,
        removeOnComplete: { age: COMPLETED_JOB_AGE_SECONDS },
        removeOnFail: { age: FAILED_JOB_AGE_SECONDS },
      },
    );
    return job.id ? { messageId: job.id } : {};
  },
  // Workers pull jobs from Redis, so nothing pushes to these routes.
  createCallback: () => async () =>
    new Response("This queue provider does not push messages", {
      status: 404,
    }),
  startWorker,
};
