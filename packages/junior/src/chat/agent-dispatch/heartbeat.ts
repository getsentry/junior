import { backfillCacheWarmingGaps } from "@/chat/cache-warming/backfill";
import { createConversationEmbedder } from "@/chat/conversations/embedding";
import { runConversationEmbeddingBackfill } from "@/chat/conversations/embedding-backfill";
import { isEventEmbeddingsEnabled } from "@/chat/conversations/event-embedding-config";
import { runEventSearchBackfill } from "@/chat/conversations/event-search-backfill";
import { runSavingsRefillSlice } from "@/chat/cache-warming/savings-refill";
import { syncAutomationAlerts } from "@/chat/automations/alert-items";
import { getDb } from "@/chat/db";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import { runInboxSnoozeTimers } from "@/chat/inbox-snoozes/triggers";
import { runInboxItemPushTimers } from "@/chat/notifications/inbox-item-push";
import { getRegistrations } from "@/chat/plugins/hooks/registry";
import {
  createPluginEventPublisher,
  type AppEventPublisher,
} from "@/chat/plugins/hooks/routes";
import type { ShowInboxItem } from "@/chat/inbox-items/changes";
import type { SendPluginTask } from "@/chat/plugins/task-runner";
import { logException, logInfo } from "@/chat/logging";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runScheduledAutomationHeartbeat } from "@/chat/scheduled-automations/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { createHeartbeatContext } from "./context";
import type { IdentityDispatcher } from "./identity";
import { createEndStoppedChildWork } from "@/chat/child-agents/result";
import {
  confirmDispatchMailboxAppend,
  getDispatchRecord,
  isTerminalDispatchStatus,
  listPendingDispatchMailboxAppends,
  markDispatchFailed,
} from "./store";
import {
  AGENT_DISPATCH_MAX_AGE_MS,
  enqueueAgentDispatch,
  failStoppedDispatch,
} from "./work";

const DEFAULT_PLUGIN_LIMIT = 25;
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 25_000;
const DISPATCH_MAILBOX_APPEND_LIMIT = 100;
async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Plugin heartbeat exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Run plugin heartbeat hooks with bounded per-invocation work. */
async function runPluginHeartbeats(args: {
  conversationWorkQueue: ConversationWorkQueue;
  dispatchForIdentity: IdentityDispatcher;
  events: AppEventPublisher;
  limit?: number;
  nowMs: number;
  sendPluginTask: SendPluginTask;
  showInboxItem?: ShowInboxItem | undefined;
}): Promise<void> {
  let count = 0;
  /* oxlint-disable no-await-in-loop -- Plugin dispatches take the shared pending-append index lock, which does not wait. */
  for (const plugin of getRegistrations()) {
    const pluginName = plugin.manifest.name;
    if (count >= (args.limit ?? DEFAULT_PLUGIN_LIMIT)) {
      break;
    }
    const heartbeat = plugin.hooks?.heartbeat;
    if (!heartbeat) {
      continue;
    }
    count += 1;
    try {
      const result = await runWithTimeout(
        Promise.resolve(
          heartbeat(
            createHeartbeatContext({
              conversationWorkQueue: args.conversationWorkQueue,
              dispatchForIdentity: args.dispatchForIdentity,
              events: createPluginEventPublisher(plugin, args.events),
              plugin,
              nowMs: args.nowMs,
              sendPluginTask: args.sendPluginTask,
              showInboxItem: args.showInboxItem,
            }),
          ),
        ),
        PLUGIN_HEARTBEAT_TIMEOUT_MS,
      );
      if (
        typeof result?.dispatchCount === "number" &&
        result.dispatchCount > 0
      ) {
        logInfo("plugin.heartbeat.dispatched", {
          "app.dispatch.count": result.dispatchCount,
          "app.plugin.name": pluginName,
        });
      }
    } catch (error) {
      logException(error, "plugin.heartbeat.failed", {
        "app.plugin.name": pluginName,
      });
    }
  }
  /* oxlint-enable no-await-in-loop */
}

/**
 * Repair bounded dispatch mailbox appends that crashed before enqueue.
 *
 * This index is only an ingress receipt; conversation work owns execution,
 * leases, retries, and continuation after the mailbox append succeeds.
 */
export async function recoverPendingDispatchMailboxAppends(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  const ids = (await listPendingDispatchMailboxAppends()).slice(
    0,
    DISPATCH_MAILBOX_APPEND_LIMIT,
  );
  /* oxlint-disable no-await-in-loop -- Each confirm takes the shared pending-append index lock, which does not wait. */
  for (const id of ids) {
    try {
      const dispatch = await getDispatchRecord(id);
      if (!dispatch || isTerminalDispatchStatus(dispatch.status)) {
        await confirmDispatchMailboxAppend(id);
        continue;
      }
      if (args.nowMs - dispatch.createdAtMs > AGENT_DISPATCH_MAX_AGE_MS) {
        await markDispatchFailed(
          id,
          "Dispatch expired before its conversation mailbox append completed",
        );
        await confirmDispatchMailboxAppend(id);
        continue;
      }
      await enqueueAgentDispatch(dispatch, {
        nowMs: args.nowMs,
        queue: args.conversationWorkQueue,
      });
    } catch (error) {
      logException(error, "dispatch.mailbox.append_recovery.failed", {
        "app.dispatch.id": id,
      });
    }
  }
  /* oxlint-enable no-await-in-loop */
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: {
  conversationWorkQueue?: ConversationWorkQueue | undefined;
  dispatchForIdentity: IdentityDispatcher;
  /** The app's event publisher. */
  events: AppEventPublisher;
  nowMs: number;
  /** Sends plugin tasks. */
  sendPluginTask: SendPluginTask;
  /** Shows an Inbox item that a plugin heartbeat changed. */
  showInboxItem?: ShowInboxItem | undefined;
}): Promise<void> {
  const queue = args.conversationWorkQueue ?? getVercelConversationWorkQueue();
  const endStoppedChildWork = createEndStoppedChildWork({ queue });
  await recoverConversationWork({
    beforeWorkStops: async (conversationId, inboundMessageIds) => {
      await endStoppedChildWork(conversationId, inboundMessageIds);
      await failStoppedDispatch(conversationId);
    },
    nowMs: args.nowMs,
    queue,
  });
  await recoverPendingDispatchMailboxAppends({
    conversationWorkQueue: queue,
    nowMs: args.nowMs,
  });
  try {
    const dispatchCount = await runScheduledAutomationHeartbeat({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    });
    if (dispatchCount > 0) {
      logInfo("scheduled_automations.heartbeat.dispatched", {
        "app.dispatch.count": dispatchCount,
      });
    }
  } catch (error) {
    logException(error, "scheduled_automations.heartbeat.failed");
  }
  try {
    const woke = await runInboxSnoozeTimers(getDb(), args.nowMs);
    if (woke > 0) {
      logInfo("inbox_snoozes.heartbeat.woken", {
        "app.inbox_snooze.count": woke,
      });
    }
  } catch (error) {
    logException(error, "inbox_snoozes.heartbeat.failed");
  }
  try {
    await runInboxItemPushTimers(getDb(), args.nowMs);
  } catch (error) {
    logException(error, "inbox_item_push.heartbeat.failed");
  }
  try {
    await syncAutomationAlerts(getDb(), args.nowMs);
  } catch (error) {
    logException(error, "automation_alerts.heartbeat.failed");
  }
  try {
    await runTimerWatchHeartbeat({ nowMs: args.nowMs, queue });
  } catch (error) {
    // Timer claims expire for retry; a failure must not block plugin heartbeats.
    logException(error, "watches.timer.heartbeat.failed");
  }
  await runPluginHeartbeats({
    conversationWorkQueue: queue,
    dispatchForIdentity: args.dispatchForIdentity,
    events: args.events,
    nowMs: args.nowMs,
    sendPluginTask: args.sendPluginTask,
    showInboxItem: args.showInboxItem,
  });
  try {
    // Last, so a long first run does not delay the work above.
    await backfillCacheWarmingGaps({ nowMs: args.nowMs });
  } catch (error) {
    logException(error, "cache_warming.backfill.failed");
  }
  try {
    await runSavingsRefillSlice({ nowMs: args.nowMs });
  } catch (error) {
    logException(error, "cache_warming.savings_refill.failed");
  }
  try {
    await runConversationEmbeddingBackfill(
      createConversationEmbedder({
        // One batch embeds the metadata of many Conversations, so no one
        // Conversation pays. The cost stays on the span.
        cost: { owner: "none" },
        operation: "conversation_embedding",
      }),
    );
  } catch (error) {
    // The claim expires, and a later heartbeat tries again.
    logException(error, "conversation_embeddings.backfill.failed");
  }
  try {
    await runEventSearchBackfill({
      ...(isEventEmbeddingsEnabled()
        ? {
            embedder: createConversationEmbedder({
              // The cost stays on the span, like the embedding backfill above.
              cost: { owner: "none" },
              operation: "conversation_embedding",
            }),
          }
        : undefined),
      nowMs: args.nowMs,
    });
  } catch (error) {
    // The claim expires, and a later heartbeat tries again.
    logException(error, "event_search.backfill.failed");
  }
}
