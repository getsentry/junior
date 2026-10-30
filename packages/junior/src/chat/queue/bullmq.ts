import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { getChatConfig } from "@/chat/config";
import { logException, logInfo } from "@/chat/logging";
import type {
  QueueConsumer,
  QueueMessageMetadata,
  QueueProvider,
  QueueSendOptions,
  QueueSendResult,
  QueueWorker,
} from "@/chat/queue/provider";

// Module overview: a queue provider for local development, backed by BullMQ
// on Redis, so `pnpm dev` needs no Vercel Queues access. Deployed apps use
// the Vercel provider.
//
// This module keeps no state between calls. Each `send()` opens a Redis
// client, adds the job, and closes the client. The dev server starts one
// separate worker process that calls `startWorker()`. That worker owns its
// Redis client and BullMQ workers, and `close()` releases them.
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
// A job id drops a second send only while BullMQ still stores the first job.
// So this is the dedupe window for idempotency keys.
const COMPLETED_JOB_AGE_SECONDS = 60 * 60;
const FAILED_JOB_AGE_SECONDS = 24 * 60 * 60;

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

/** Load BullMQ and open a Redis client that the caller must close. */
async function connect(): Promise<{
  bullmq: BullMq;
  connection: RedisConnection;
}> {
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

/** Start one BullMQ worker for each consumer, on a Redis client it owns. */
async function startWorker(consumers: QueueConsumer[]): Promise<QueueWorker> {
  const { bullmq, connection } = await connect();
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
    // `close()` waits for running jobs without a time limit. The dev server
    // stops the worker process if it does not exit within its grace period.
    close: async () => {
      try {
        const failures = (
          await Promise.allSettled(workers.map((worker) => worker.close()))
        ).flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "BullMQ workers did not close");
        }
      } finally {
        await connection.quit();
      }
    },
  };
}

/** Add one job on a Redis client that is open only for this send. */
async function send(
  topic: string,
  payload: unknown,
  options: QueueSendOptions = {},
): Promise<QueueSendResult> {
  const { bullmq, connection } = await connect();
  const queue = new bullmq.Queue<JobData>(topic, { connection });
  try {
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
  } finally {
    try {
      await queue.close();
    } finally {
      await connection.quit();
    }
  }
}

/** Queue provider backed by BullMQ, for local development only. */
export const bullmqQueueProvider: QueueProvider = {
  messagingSystem: "bullmq",
  send,
  // Workers pull jobs from Redis, so nothing pushes to these routes.
  createCallback: () => async () =>
    new Response("This queue provider does not push messages", {
      status: 404,
    }),
  startWorker,
};
