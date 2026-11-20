/**
 * Messages of background compaction jobs.
 *
 * A message names one `compaction_requested` event. The event log holds the
 * request, and the State adapter holds the request snapshot, so the message
 * stays small.
 */
import { createHash } from "node:crypto";
import * as z from "zod";
import { getQueueProvider } from "@/chat/queue/provider";
import {
  QUEUE_SIGNATURE_MAX_AGE_MS,
  signQueueMessage,
  verifyQueueMessage,
} from "@/chat/queue/sign";

/** Deploy topic name. Keep stable for Vercel queue wiring. */
export const BACKGROUND_COMPACTION_QUEUE_TOPIC = "junior_context_compaction";

const backgroundCompactionMessageSchema = z
  .object({
    conversationId: z.string().min(1),
    historyVersion: z.number().int().nonnegative(),
    markSeq: z.number().int().nonnegative(),
  })
  .strict();

/** One background compaction job: the request that it prepares a summary for. */
export type BackgroundCompactionMessage = z.output<
  typeof backgroundCompactionMessageSchema
>;

/** Sends background compaction jobs. Tests and evals can run them in process. */
export interface BackgroundCompactionQueue {
  send(message: BackgroundCompactionMessage): Promise<void>;
}

const backgroundCompactionSign = {
  context: "junior.context_compaction_queue.v1",
  schema: backgroundCompactionMessageSchema,
  signatureVersion: "v1" as const,
  parts: (message: BackgroundCompactionMessage) => [
    message.conversationId,
    String(message.historyVersion),
    String(message.markSeq),
  ],
};

/** Stable id of one request, for event, snapshot, and delivery dedupe. */
export function backgroundCompactionId(
  message: BackgroundCompactionMessage,
): string {
  const digest = createHash("sha256")
    .update(message.conversationId)
    .update("\0")
    .update(String(message.historyVersion))
    .update("\0")
    .update(String(message.markSeq))
    .digest("hex")
    .slice(0, 32);
  return `context-compaction_${digest}`;
}

/** Check that a recent queue message came from Junior. */
export function verifyBackgroundCompactionMessage(value: unknown) {
  return verifyQueueMessage(backgroundCompactionSign, value);
}

/** The production queue for background compaction jobs. */
export const vercelBackgroundCompactionQueue: BackgroundCompactionQueue = {
  send: async (message) => {
    await getQueueProvider().send(
      BACKGROUND_COMPACTION_QUEUE_TOPIC,
      signQueueMessage(backgroundCompactionSign, message),
      {
        idempotencyKey: backgroundCompactionId(message),
        retentionSeconds: QUEUE_SIGNATURE_MAX_AGE_MS / 1000,
      },
    );
  },
};
