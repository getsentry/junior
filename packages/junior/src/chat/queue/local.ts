// Module overview: the local queue provider, for local development and tests.
//
// It works like Vercel Queues with no external service. `send` adds a pg-boss
// job in the app's Postgres. The local queue delivery (`local-delivery.ts`)
// pushes each job to the consumer's callback route. `createCallback` handles
// that push the way the Vercel Queues SDK handles a pushed message.
import { createHash } from "node:crypto";
import type { PgBoss } from "pg-boss";
import * as z from "zod";
import { logException } from "@/chat/logging";
import {
  createLocalQueue,
  LOCAL_QUEUE_HEADERS,
  startLocalJobs,
  type LocalJobData,
} from "@/chat/queue/local-jobs";
import type {
  QueueConsumer,
  QueueMessageMetadata,
  QueueProvider,
  QueueSendOptions,
  QueueSendResult,
} from "@/chat/queue/provider";

const deliveryHeadersSchema = z.object({
  createdAt: z.coerce.date(),
  deliveryCount: z.coerce.number().int().positive(),
  messageId: z.string().min(1),
});

// One instance for each process, started on the first send, like the client
// in `vercel.ts`. It reconnects on the next send if it fails to start.
let sender: Promise<PgBoss> | undefined;

function getSender(): Promise<PgBoss> {
  sender ??= startLocalJobs({ deliver: false }).catch((error: unknown) => {
    sender = undefined;
    throw error;
  });
  return sender;
}

// pg-boss drops a job whose id it already stores, so the same key always
// gives the same job id.
function idempotencyJobId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function send(
  topic: string,
  payload: unknown,
  options: QueueSendOptions = {},
): Promise<QueueSendResult> {
  const boss = await getSender();
  await createLocalQueue(boss, topic);
  const id =
    options.idempotencyKey === undefined
      ? undefined
      : idempotencyJobId(options.idempotencyKey);
  const data: LocalJobData = {
    payload,
    retentionSeconds: options.retentionSeconds,
    sentAt: Date.now(),
  };
  const jobId = await boss.send(topic, data, {
    id,
    startAfter: options.delaySeconds,
  });
  // A duplicate send returns no job id, and the first job has the same id.
  const messageId = jobId ?? id;
  return messageId === undefined ? {} : { messageId };
}

function createCallback(
  consumer: QueueConsumer,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = deliveryHeadersSchema.safeParse({
      createdAt: request.headers.get(LOCAL_QUEUE_HEADERS.createdAt),
      deliveryCount: request.headers.get(LOCAL_QUEUE_HEADERS.deliveryCount),
      messageId: request.headers.get(LOCAL_QUEUE_HEADERS.messageId),
    });
    if (!headers.success) {
      return Response.json(
        { error: "Missing or invalid queue delivery headers" },
        { status: 400 },
      );
    }
    const payload: unknown = await request.json();
    const metadata: QueueMessageMetadata = {
      ...headers.data,
      consumerGroup: consumer.consumerGroup,
      topicName: consumer.topic,
    };
    try {
      await consumer.handler(payload, metadata);
    } catch (error) {
      if (!consumer.retry(error, metadata)?.acknowledge) {
        logException(error, "queue.local.callback.exception", {
          "messaging.destination.name": consumer.topic,
          "messaging.message.id": metadata.messageId,
        });
        // A failed response tells the local queue delivery to retry.
        return Response.json(
          { error: "Failed to process queue message" },
          { status: 500 },
        );
      }
    }
    return Response.json({ status: "success" });
  };
}

/** Queue provider that keeps messages in the app's Postgres for local runs. */
export const localQueueProvider: QueueProvider = {
  messagingSystem: "pg-boss",
  send,
  createCallback,
};
