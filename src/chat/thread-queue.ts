import { LockError, Message } from "chat";
import { getRedisClient, getStateAdapter } from "@/chat/state";
import { logInfo, logWarn, logError } from "@/chat/observability";

const QUEUE_KEY_PREFIX = "chat-sdk:queue:thread:";
const MAX_QUEUE_DEPTH = 5;
const QUEUE_TTL_MS = 10 * 60 * 1000;

interface QueuedMessage {
  enqueuedAt: number;
  adapterName: string;
  threadId: string;
  messageId: string | undefined;
  messageData: unknown;
}

function queueKey(threadId: string): string {
  return `${QUEUE_KEY_PREFIX}${threadId}`;
}

export async function enqueueMessage(
  threadId: string,
  adapterName: string,
  message: unknown
): Promise<void> {
  const client = getRedisClient();
  const key = queueKey(threadId);

  const len = await client.lLen(key);
  if (len >= MAX_QUEUE_DEPTH) {
    logWarn("thread_queue_full", {}, {
      "messaging.message.conversation_id": threadId,
      "app.queue_depth": len,
    }, "Thread queue full, dropping message");
    return;
  }

  const messageId = (message as { id?: string } | null)?.id;

  // Clear the SDK's dedup key so the message can be replayed when drained.
  if (messageId) {
    try {
      await getStateAdapter().delete(`dedupe:${adapterName}:${messageId}`);
    } catch {
      // best-effort
    }
  }

  const entry: QueuedMessage = {
    enqueuedAt: Date.now(),
    adapterName,
    threadId,
    messageId,
    messageData: JSON.parse(JSON.stringify(message)),
  };

  await client.rPush(key, JSON.stringify(entry));
  await client.pExpire(key, QUEUE_TTL_MS);

  logInfo("thread_queue_enqueued", {}, {
    "messaging.message.conversation_id": threadId,
    "messaging.message.id": messageId,
    "app.queue_depth": len + 1,
  }, "Message enqueued for thread");
}

export async function drainThreadQueue(
  chat: { handleIncomingMessage: (adapter: unknown, threadId: string, message: unknown) => Promise<void> },
  adapter: unknown,
  threadId: string
): Promise<void> {
  const client = getRedisClient();
  const key = queueKey(threadId);

  for (let i = 0; i < MAX_QUEUE_DEPTH; i++) {
    const raw = await client.lPop(key);
    if (!raw) break;

    let entry: QueuedMessage;
    try {
      entry = JSON.parse(raw) as QueuedMessage;
    } catch {
      logError("thread_queue_deserialize_error", {}, {
        "messaging.message.conversation_id": threadId,
      }, "Failed to deserialize queued message");
      continue;
    }

    if (Date.now() - entry.enqueuedAt > QUEUE_TTL_MS) {
      logWarn("thread_queue_stale", {}, {
        "messaging.message.conversation_id": threadId,
        "messaging.message.id": entry.messageId,
        "app.age_ms": Date.now() - entry.enqueuedAt,
      }, "Skipping stale queued message");
      continue;
    }

    // Clear dedup key before replay so the SDK doesn't reject it.
    if (entry.messageId) {
      try {
        await getStateAdapter().delete(`dedupe:${entry.adapterName}:${entry.messageId}`);
      } catch {
        // best-effort
      }
    }

    const message = new Message(entry.messageData as ConstructorParameters<typeof Message>[0]);

    logInfo("thread_queue_draining", {}, {
      "messaging.message.conversation_id": threadId,
      "messaging.message.id": entry.messageId,
    }, "Processing queued message");

    try {
      await chat.handleIncomingMessage(adapter, threadId, message);
    } catch (err) {
      if (err instanceof LockError) {
        // Another instance grabbed the lock between turns. Re-enqueue and stop.
        await client.lPush(key, raw);
        await client.pExpire(key, QUEUE_TTL_MS);
        logInfo("thread_queue_requeued", {}, {
          "messaging.message.conversation_id": threadId,
          "messaging.message.id": entry.messageId,
        }, "Re-enqueued message after LockError during drain");
        return;
      }
      logError("thread_queue_drain_error", {}, {
        "messaging.message.conversation_id": threadId,
        "messaging.message.id": entry.messageId,
        "app.error": String(err),
      }, "Error processing queued message");
      continue;
    }
  }
}
