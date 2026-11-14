import { backfillCacheWarmingGaps } from "@/chat/cache-warming/backfill";
import { runSavingsRefillSlice } from "@/chat/cache-warming/savings-refill";
import { runTimerWatchHeartbeat } from "@/chat/events/timers";
import {
  createPluginEventPublisher,
  getPlugins,
  type AppEventPublisher,
} from "@/chat/plugins/agent-hooks";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import type { ShowReviewItem } from "@/chat/review-items/changes";
import { logInfo } from "@/chat/logging";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runScheduledAutomationHeartbeat } from "@/chat/scheduled-automations/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { createHeartbeatContext } from "./context";
import {
  listPendingAgentInvocationMailboxAppends,
  listPendingAgentInvocationResults,
} from "@/chat/agent-invocations/store";
import {
  createEndStoppedChildWork,
  enqueueAgentInvocationResult,
} from "@/chat/agent-invocations/result";
import { recordSubagentEnded } from "@/chat/agent-invocations/markers";
import { enqueueAgentInvocation } from "@/chat/agent-invocations/work";
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
const AGENT_INVOCATION_MAILBOX_APPEND_LIMIT = 100;
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
export async function runPluginHeartbeats(args: {
  conversationWorkQueue: ConversationWorkQueue;
  events: AppEventPublisher;
  limit?: number;
  nowMs: number;
  showReviewItem?: ShowReviewItem | undefined;
}): Promise<void> {
  let count = 0;
  const errors: unknown[] = [];
  for (const plugin of getPlugins()) {
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
              events: createPluginEventPublisher(plugin, args.events),
              plugin,
              nowMs: args.nowMs,
              showReviewItem: args.showReviewItem,
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
      // One plugin's failure must not skip the plugins after it.
      errors.push(
        new Error(`Plugin heartbeat failed: ${pluginName}`, { cause: error }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Plugin heartbeats failed");
  }
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
  const errors: unknown[] = [];
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
      // The item stays pending, so the next heartbeat retries it.
      errors.push(
        new Error(`Dispatch mailbox append recovery failed: ${id}`, {
          cause: error,
        }),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Dispatch mailbox append recovery failed");
  }
}

/** Repair invocation creation that stopped before its idempotent mailbox append. */
export async function recoverPendingAgentInvocationMailboxAppends(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  const invocations = await listPendingAgentInvocationMailboxAppends(
    AGENT_INVOCATION_MAILBOX_APPEND_LIMIT,
  );
  const errors: unknown[] = [];
  for (const invocation of invocations) {
    try {
      await enqueueAgentInvocation(invocation, {
        nowMs: args.nowMs,
        queue: args.conversationWorkQueue,
      });
    } catch (error) {
      // The item stays pending, so the next heartbeat retries it.
      errors.push(
        new Error(
          `Agent invocation mailbox append recovery failed: ${invocation.invocationId}`,
          { cause: error },
        ),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Agent invocation mailbox append recovery failed",
    );
  }
}

/** Repair terminal agent invocation results that never reached their parent. */
export async function recoverPendingAgentInvocationResults(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  const invocations = await listPendingAgentInvocationResults(
    AGENT_INVOCATION_MAILBOX_APPEND_LIMIT,
  );
  const errors: unknown[] = [];
  for (const invocation of invocations) {
    try {
      await recordSubagentEnded(invocation);
      await enqueueAgentInvocationResult(invocation, {
        nowMs: args.nowMs,
        queue: args.conversationWorkQueue,
      });
    } catch (error) {
      // The item stays pending, so the next heartbeat retries it.
      errors.push(
        new Error(
          `Agent invocation result recovery failed: ${invocation.invocationId}`,
          { cause: error },
        ),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Agent invocation result recovery failed");
  }
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: {
  conversationWorkQueue?: ConversationWorkQueue | undefined;
  /** The app's event publisher. */
  events?: AppEventPublisher | undefined;
  nowMs: number;
  /** Shows a Review item that a plugin heartbeat changed. */
  showReviewItem?: ShowReviewItem | undefined;
}): Promise<void> {
  const queue = args.conversationWorkQueue ?? getVercelConversationWorkQueue();
  const events =
    args.events ??
    createEventAppPublisher({ conversationWork: () => ({ queue }) });
  const errors: unknown[] = [];
  // Each step runs even when an earlier one fails. Failed work stays pending
  // for the next heartbeat, and every failure reaches the heartbeat boundary.
  const step = async (run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      errors.push(error);
    }
  };
  // Runs before result recovery, so an invocation that this ends is sent to
  // its parent in the same heartbeat.
  const endStoppedChildWork = createEndStoppedChildWork({ queue });
  await step(() =>
    recoverConversationWork({
      beforeWorkStops: async (conversationId, inboundMessageIds) => {
        await endStoppedChildWork(conversationId, inboundMessageIds);
        await failStoppedDispatch(conversationId);
      },
      nowMs: args.nowMs,
      queue,
    }),
  );
  await step(() =>
    recoverPendingDispatchMailboxAppends({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    }),
  );
  await step(() =>
    recoverPendingAgentInvocationMailboxAppends({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    }),
  );
  await step(() =>
    recoverPendingAgentInvocationResults({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    }),
  );
  await step(async () => {
    const dispatchCount = await runScheduledAutomationHeartbeat({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    });
    if (dispatchCount > 0) {
      logInfo("scheduled_automations.heartbeat.dispatched", {
        "app.dispatch.count": dispatchCount,
      });
    }
  });
  // Timer claims expire, so a failed timer is retried.
  await step(() => runTimerWatchHeartbeat({ nowMs: args.nowMs, queue }));
  await step(() =>
    runPluginHeartbeats({
      conversationWorkQueue: queue,
      events,
      nowMs: args.nowMs,
      showReviewItem: args.showReviewItem,
    }),
  );
  // Last, so a long first run does not delay the work above.
  await step(() => backfillCacheWarmingGaps({ nowMs: args.nowMs }));
  await step(() => runSavingsRefillSlice({ nowMs: args.nowMs }));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Heartbeat steps failed");
  }
}
