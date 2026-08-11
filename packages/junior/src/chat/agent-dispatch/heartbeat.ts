import { getPlugins } from "@/chat/plugins/agent-hooks";
import { logException, logInfo } from "@/chat/logging";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runScheduledTaskHeartbeat } from "@/chat/scheduled-tasks/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { createHeartbeatContext } from "./context";
import { listPendingAgentInvocationMailboxAppends } from "@/chat/agent-invocations/store";
import { enqueueAgentInvocation } from "@/chat/agent-invocations/work";
import {
  confirmDispatchMailboxAppend,
  getDispatchRecord,
  isTerminalDispatchStatus,
  listPendingDispatchMailboxAppends,
  markDispatchFailed,
} from "./store";
import { AGENT_DISPATCH_MAX_AGE_MS, enqueueAgentDispatch } from "./work";

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
  limit?: number;
  nowMs: number;
}): Promise<void> {
  let count = 0;
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
              plugin,
              nowMs: args.nowMs,
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
}

/**
 * Repair bounded dispatch mailbox appends, including pre-cutover records.
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
}

/** Repair invocation creation that stopped before its idempotent mailbox append. */
export async function recoverPendingAgentInvocationMailboxAppends(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  const invocations = await listPendingAgentInvocationMailboxAppends(
    AGENT_INVOCATION_MAILBOX_APPEND_LIMIT,
  );
  for (const invocation of invocations) {
    try {
      await enqueueAgentInvocation(invocation, {
        nowMs: args.nowMs,
        queue: args.conversationWorkQueue,
      });
    } catch (error) {
      logException(error, "agent.invocation.mailbox.append_recovery.failed", {
        "app.agent.invocation_id": invocation.invocationId,
      });
    }
  }
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: {
  conversationWorkQueue?: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  const queue = args.conversationWorkQueue ?? getVercelConversationWorkQueue();
  await recoverConversationWork({
    nowMs: args.nowMs,
    queue,
  });
  await recoverPendingDispatchMailboxAppends({
    conversationWorkQueue: queue,
    nowMs: args.nowMs,
  });
  await recoverPendingAgentInvocationMailboxAppends({
    conversationWorkQueue: queue,
    nowMs: args.nowMs,
  });
  try {
    const dispatchCount = await runScheduledTaskHeartbeat({
      conversationWorkQueue: queue,
      nowMs: args.nowMs,
    });
    if (dispatchCount > 0) {
      logInfo("scheduled_tasks.heartbeat.dispatched", {
        "app.dispatch.count": dispatchCount,
      });
    }
  } catch (error) {
    logException(error, "scheduled_tasks.heartbeat.failed");
  }
  await runPluginHeartbeats({
    conversationWorkQueue: queue,
    nowMs: args.nowMs,
  });
}
