/** Bind sign, send, and callback wiring for one simple queue job. */
import type { MessageMetadata } from "@vercel/queue";
import { z } from "zod";
import { logWarn } from "@/chat/logging";
import { createVercelQueueClient } from "@/chat/vercel-queue-client";
import { queueCallback } from "./callback";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
  type QueueSignConfig,
} from "./sign";

export interface QueueJobOptions<
  Message extends object,
  Version extends string,
> {
  consumerGroup: string;
  context: string;
  id(message: Message): string;
  /** Required. Simple jobs own this limit in the callback. */
  maxDeliveries: number;
  parts(message: Message): readonly string[];
  rejectedLog?: string;
  run(message: Message): Promise<void>;
  schema: z.ZodType<Message>;
  topic: string;
  version: Version;
}

/** Create one simple queue job with send + handle helpers. */
export function queueJob<Message extends object, Version extends string>(
  options: QueueJobOptions<Message, Version>,
) {
  const signConfig: QueueSignConfig<Message, Version> = {
    context: options.context,
    schema: options.schema,
    signatureVersion: options.version,
    parts: options.parts,
  };
  const retentionSeconds = QUEUE_SIGNATURE_MAX_AGE_MS / 1000;
  const rejectedLog = options.rejectedLog ?? "queue.message.rejected";

  function sign(message: Message, nowMs = Date.now()) {
    return signQueueMessage(signConfig, message, nowMs);
  }

  function verify(value: unknown, nowMs = Date.now()) {
    return verifyQueueMessage(signConfig, value, nowMs);
  }

  function onRejected(reason: string, metadata: MessageMetadata): void {
    logWarn(rejectedLog, {
      "app.queue.consumer_group": metadata.consumerGroup,
      "app.queue.delivery_count": metadata.deliveryCount,
      "app.queue.message_id": metadata.messageId,
      "app.queue.reject_reason": reason,
      "app.queue.topic_name": metadata.topicName,
    });
  }

  function callback() {
    return queueCallback({
      consumerGroup: options.consumerGroup,
      maxDeliveries: options.maxDeliveries,
      onRejected,
      run: async (message) => options.run(message),
      topic: options.topic,
      verify,
    });
  }

  return {
    topic: options.topic,
    sign,
    verify,
    async send(message: Message): Promise<void> {
      await createVercelQueueClient().send(options.topic, sign(message), {
        idempotencyKey: options.id(message),
        retentionSeconds,
      });
    },
    handle(): (request: Request) => Promise<Response> {
      return callback().create();
    },
    registerDev(): (() => void) | undefined {
      return callback().registerDev();
    },
  };
}
