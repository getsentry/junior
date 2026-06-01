import { handleCallback } from "@vercel/queue";
import type { StateAdapter } from "chat";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import type { ConversationQueueMessage, ConversationWorkQueue } from "./queue";
import { getVercelConversationWorkQueue } from "./vercel-queue";
import {
  processConversationWork,
  type ConversationWorkProcessResult,
  type ConversationWorkerResult,
  type ConversationWorkerContext,
} from "./worker";

export const CONVERSATION_WORK_VISIBILITY_TIMEOUT_SECONDS = 300;

export interface ProcessConversationQueueMessageOptions {
  checkInIntervalMs?: number;
  nowMs?: () => number;
  queue?: ConversationWorkQueue;
  run(context: ConversationWorkerContext): Promise<ConversationWorkerResult>;
  softYieldAfterMs?: number;
  state?: StateAdapter;
}

export interface VercelConversationWorkCallbackOptions extends ProcessConversationQueueMessageOptions {
  visibilityTimeoutSeconds?: number;
}

function parseConversationQueueMessage(
  message: unknown,
): ConversationQueueMessage {
  if (
    !message ||
    typeof message !== "object" ||
    typeof (message as { conversationId?: unknown }).conversationId !==
      "string" ||
    !(message as { conversationId: string }).conversationId.trim()
  ) {
    throw new Error("Conversation queue message is missing conversationId");
  }
  return {
    conversationId: (message as { conversationId: string }).conversationId,
  };
}

/** Process one Vercel Queue payload with the generic conversation worker. */
export async function processConversationQueueMessage(
  message: unknown,
  options: ProcessConversationQueueMessageOptions,
): Promise<ConversationWorkProcessResult> {
  const parsed = parseConversationQueueMessage(message);
  return await processConversationWork(parsed.conversationId, {
    checkInIntervalMs: options.checkInIntervalMs,
    nowMs: options.nowMs,
    queue: options.queue ?? getVercelConversationWorkQueue(),
    run: options.run,
    softYieldAfterMs: options.softYieldAfterMs,
    state: options.state,
  });
}

/** Create the Vercel Queue push callback for conversation work nudges. */
export function createVercelConversationWorkCallback(
  options: VercelConversationWorkCallbackOptions,
): (request: Request) => Promise<Response> {
  return handleCallback(
    async (message: unknown) => {
      await runWithTurnRequestDeadline(() =>
        processConversationQueueMessage(message, options),
      );
    },
    {
      visibilityTimeoutSeconds:
        options.visibilityTimeoutSeconds ??
        CONVERSATION_WORK_VISIBILITY_TIMEOUT_SECONDS,
    },
  );
}
