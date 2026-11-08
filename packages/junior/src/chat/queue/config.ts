import { toOptionalTrimmed } from "@/chat/optional-string";

/** Which queue delivers background work. */
export type QueueConfig =
  | { provider: "vercel" }
  | { provider: "bullmq"; redisUrl: string; workerConcurrency: number };

/** Jobs that one BullMQ worker runs at the same time, for each queue topic. */
const DEFAULT_BULLMQ_WORKER_CONCURRENCY = 4;

function readWorkerConcurrency(value: string | undefined): number {
  const raw = toOptionalTrimmed(value);
  if (raw === undefined) {
    return DEFAULT_BULLMQ_WORKER_CONCURRENCY;
  }
  const concurrency = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1
  ) {
    throw new Error(
      "JUNIOR_QUEUE_WORKER_CONCURRENCY must be a positive integer",
    );
  }
  return concurrency;
}

/** Read queue settings from environment variables. */
export function readQueueConfig(env: NodeJS.ProcessEnv): QueueConfig {
  const provider = toOptionalTrimmed(env.JUNIOR_QUEUE_PROVIDER) ?? "vercel";
  switch (provider) {
    case "vercel":
      return { provider };
    case "bullmq": {
      const redisUrl = toOptionalTrimmed(env.JUNIOR_QUEUE_REDIS_URL);
      if (!redisUrl) {
        throw new Error(
          "JUNIOR_QUEUE_REDIS_URL is required when JUNIOR_QUEUE_PROVIDER is bullmq",
        );
      }
      return {
        provider,
        redisUrl,
        workerConcurrency: readWorkerConcurrency(
          env.JUNIOR_QUEUE_WORKER_CONCURRENCY,
        ),
      };
    }
    default:
      throw new Error("JUNIOR_QUEUE_PROVIDER must be vercel or bullmq");
  }
}
