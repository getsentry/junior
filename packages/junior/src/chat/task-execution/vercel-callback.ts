import {
  handleCallback,
  QueueClient,
  registerDevConsumer,
} from "@vercel/queue";
import type { StateAdapter } from "chat";
import { getChatConfig } from "@/chat/config";
import { parseDestination } from "@/chat/destination";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import type { ConversationQueueMessage, ConversationWorkQueue } from "./queue";
import {
  getVercelConversationWorkQueue,
  resolveConversationWorkQueueTopic,
} from "./vercel-queue";
import {
  processConversationWork,
  type ConversationWorkProcessResult,
  type ConversationWorkerResult,
  type ConversationWorkerContext,
} from "./worker";
import { verifySignedConversationQueueMessage } from "./queue-signing";

export const CONVERSATION_WORK_VISIBILITY_TIMEOUT_BUFFER_SECONDS = 30;
export const CONVERSATION_WORK_DEV_CONSUMER_GROUP =
  "junior_conversation_work_dev";

export interface ProcessConversationQueueMessageOptions {
  checkInIntervalMs?: number;
  nowMs?: () => number;
  queue?: ConversationWorkQueue;
  run(context: ConversationWorkerContext): Promise<ConversationWorkerResult>;
  softYieldAfterMs?: number;
  state?: StateAdapter;
}

export interface VercelConversationWorkCallbackOptions extends ProcessConversationQueueMessageOptions {
  topic?: string;
  visibilityTimeoutSeconds?: number;
}

function parseConversationQueueMessage(
  message: unknown,
): ConversationQueueMessage {
  const destination = parseDestination(
    (message as { destination?: unknown } | undefined)?.destination,
  );
  if (
    !message ||
    typeof message !== "object" ||
    typeof (message as { conversationId?: unknown }).conversationId !==
      "string" ||
    !(message as { conversationId: string }).conversationId.trim() ||
    !destination
  ) {
    throw new Error(
      "Conversation queue message is missing destination context",
    );
  }
  return {
    conversationId: (message as { conversationId: string }).conversationId,
    destination,
  };
}

/** Resolve queue visibility so redelivery waits past the host timeout boundary. */
export function resolveConversationWorkVisibilityTimeoutSeconds(
  functionMaxDurationSeconds = getChatConfig().functionMaxDurationSeconds,
): number {
  return (
    functionMaxDurationSeconds +
    CONVERSATION_WORK_VISIBILITY_TIMEOUT_BUFFER_SECONDS
  );
}

/** Process one Vercel Queue payload with the generic conversation worker. */
export async function processConversationQueueMessage(
  message: unknown,
  options: ProcessConversationQueueMessageOptions,
): Promise<ConversationWorkProcessResult> {
  const parsed = parseConversationQueueMessage(message);
  return await processConversationWork(parsed, {
    checkInIntervalMs: options.checkInIntervalMs,
    nowMs: options.nowMs,
    queue: options.queue ?? getVercelConversationWorkQueue(),
    run: options.run,
    softYieldAfterMs: options.softYieldAfterMs,
    state: options.state,
  });
}

async function handleConversationQueueMessage(
  message: unknown,
  options: VercelConversationWorkCallbackOptions,
): Promise<void> {
  const verified = verifySignedConversationQueueMessage(message);
  if (!verified) {
    throw new Error("Unauthorized conversation queue message");
  }
  await runWithTurnRequestDeadline(() =>
    processConversationQueueMessage(verified, options),
  );
}

/** Create the Vercel Queue push callback for conversation work nudges. */
export function createVercelConversationWorkCallback(
  options: VercelConversationWorkCallbackOptions,
): (request: Request) => Promise<Response> {
  return handleCallback(
    (message: unknown) => handleConversationQueueMessage(message, options),
    {
      visibilityTimeoutSeconds:
        options.visibilityTimeoutSeconds ??
        resolveConversationWorkVisibilityTimeoutSeconds(),
    },
  );
}

/** Register the Vercel Queue local-dev consumer for Nitro's central route dispatcher. */
export function registerVercelConversationWorkDevConsumer(
  options: VercelConversationWorkCallbackOptions,
): (() => void) | undefined {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }

  return registerDevConsumer({
    client: new QueueClient(),
    consumerGroup: CONVERSATION_WORK_DEV_CONSUMER_GROUP,
    handler: (message: unknown) =>
      handleConversationQueueMessage(message, options),
    topic: resolveConversationWorkQueueTopic(options),
    visibilityTimeoutSeconds:
      options.visibilityTimeoutSeconds ??
      resolveConversationWorkVisibilityTimeoutSeconds(),
  });
}
