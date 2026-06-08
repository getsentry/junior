import { getAgentPlugins } from "@/chat/plugins/agent-hooks";
import { logException, logInfo } from "@/chat/logging";
import {
  getAwaitingTurnContinuationRequest,
  scheduleTurnTimeoutResume,
} from "@/chat/services/timeout-resume";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { listAgentTurnSessionSummaries } from "@/chat/state/turn-session";
import { createHeartbeatContext } from "./context";
import { scheduleDispatchCallback } from "./signing";
import {
  getDispatchStorageKey,
  getDispatchRecord,
  isTerminalDispatchStatus,
  listIncompleteDispatchIds,
  parseDispatchRecord,
  updateDispatchRecord,
  withDispatchLock,
} from "./store";
import type { DispatchRecord } from "./types";

const DEFAULT_RECOVERY_LIMIT = 25;
const DEFAULT_PLUGIN_LIMIT = 25;
const DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 25_000;
const TIMEOUT_RESUME_STALE_MS = 2 * 60 * 1000;
const TIMEOUT_RESUME_RECOVERY_SCAN_LIMIT = 500;

function isStaleDispatch(args: {
  nowMs: number;
  record: {
    lastCallbackAtMs?: number;
    leaseExpiresAtMs?: number;
    status: string;
  };
}): boolean {
  if (args.record.status === "running") {
    return (
      typeof args.record.leaseExpiresAtMs === "number" &&
      args.record.leaseExpiresAtMs <= args.nowMs
    );
  }
  if (args.record.status === "awaiting_resume") {
    return (
      typeof args.record.leaseExpiresAtMs !== "number" ||
      args.record.leaseExpiresAtMs <= args.nowMs
    );
  }
  if (args.record.status === "pending") {
    return (
      typeof args.record.lastCallbackAtMs !== "number" ||
      args.record.lastCallbackAtMs + 60_000 <= args.nowMs
    );
  }
  return false;
}

async function failDispatch(args: {
  errorMessage: string;
  record: DispatchRecord;
}): Promise<void> {
  await withDispatchLock(args.record.id, async (state) => {
    const current =
      parseDispatchRecord(
        await state.get(getDispatchStorageKey(args.record.id)),
      ) ?? args.record;
    if (isTerminalDispatchStatus(current.status)) {
      return;
    }
    await updateDispatchRecord(state, {
      ...current,
      errorMessage: args.errorMessage,
      status: "failed",
    });
  });
}
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

/** Re-drive stale turn continuations whose internal callback vanished. */
export async function recoverStaleTimeoutResumes(args: {
  conversationWorkQueue?: ConversationWorkQueue;
  limit?: number;
  nowMs: number;
}): Promise<number> {
  const summaries = await listAgentTurnSessionSummaries(
    TIMEOUT_RESUME_RECOVERY_SCAN_LIMIT,
  );
  let recovered = 0;
  for (const summary of summaries) {
    if (recovered >= (args.limit ?? DEFAULT_RECOVERY_LIMIT)) {
      break;
    }
    if (
      summary.state !== "awaiting_resume" ||
      (summary.resumeReason !== "timeout" &&
        summary.resumeReason !== "yield") ||
      summary.updatedAtMs + TIMEOUT_RESUME_STALE_MS > args.nowMs
    ) {
      continue;
    }

    try {
      const persistedState = await getPersistedThreadState(
        summary.conversationId,
      );
      const conversation = coerceThreadConversationState(persistedState);
      if (conversation.processing.activeTurnId !== summary.sessionId) {
        continue;
      }

      const request = await getAwaitingTurnContinuationRequest({
        conversationId: summary.conversationId,
        sessionId: summary.sessionId,
      });
      if (!request) {
        continue;
      }
      await scheduleTurnTimeoutResume(request, {
        queue: args.conversationWorkQueue,
      });
      recovered += 1;
      logInfo(
        "agent_turn_timeout_resume_recovery_scheduled",
        {},
        {
          "app.ai.conversation_id": summary.conversationId,
          "app.ai.session_id": summary.sessionId,
          "app.ai.resume_session_version": request.expectedVersion,
          "app.ai.resume_slice_id": summary.sliceId,
        },
        "Heartbeat rescheduled stale timeout resume",
      );
    } catch (error) {
      logException(
        error,
        "agent_turn_timeout_resume_recovery_failed",
        {},
        {
          "app.ai.conversation_id": summary.conversationId,
          "app.ai.session_id": summary.sessionId,
        },
        "Heartbeat timeout resume recovery failed",
      );
    }
  }

  return recovered;
}

/** Re-drive stale core dispatches before invoking plugin heartbeat hooks. */
export async function recoverStaleDispatches(args: {
  limit?: number;
  nowMs: number;
}): Promise<number> {
  const ids = await listIncompleteDispatchIds();
  let recovered = 0;
  for (const id of ids) {
    if (recovered >= (args.limit ?? DEFAULT_RECOVERY_LIMIT)) {
      break;
    }
    const record = await getDispatchRecord(id);
    if (!record || isTerminalDispatchStatus(record.status)) {
      continue;
    }
    try {
      if (!isStaleDispatch({ record, nowMs: args.nowMs })) {
        continue;
      }
      if (record.createdAtMs + DISPATCH_MAX_AGE_MS <= args.nowMs) {
        await failDispatch({
          record,
          errorMessage: "Dispatch expired before completion.",
        });
        continue;
      }
      if (record.attempt >= record.maxAttempts) {
        await failDispatch({
          record,
          errorMessage: "Dispatch exceeded retry attempts.",
        });
        continue;
      }
      await scheduleDispatchCallback({
        id: record.id,
        expectedVersion: record.version,
      });
      recovered += 1;
    } catch (error) {
      logException(
        error,
        "agent_dispatch_recovery_failed",
        { runId: record.id },
        { "app.plugin.name": record.plugin },
        "Agent dispatch recovery failed",
      );
    }
  }
  return recovered;
}

/** Run plugin heartbeat hooks with bounded per-invocation work. */
export async function runPluginHeartbeats(args: {
  limit?: number;
  nowMs: number;
}): Promise<void> {
  let count = 0;
  for (const plugin of getAgentPlugins()) {
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
              legacyStatePrefixes: plugin.legacyStatePrefixes,
              plugin: plugin.name,
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
        logInfo(
          "plugin_heartbeat_dispatched",
          {},
          {
            "app.dispatch.count": result.dispatchCount,
            "app.plugin.name": plugin.name,
          },
          "Plugin heartbeat dispatched agent work",
        );
      }
    } catch (error) {
      logException(
        error,
        "plugin_heartbeat_failed",
        {},
        { "app.plugin.name": plugin.name },
        "Plugin heartbeat failed",
      );
    }
  }
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: {
  conversationWorkQueue?: ConversationWorkQueue;
  nowMs: number;
}): Promise<void> {
  await recoverConversationWork({
    nowMs: args.nowMs,
    queue: args.conversationWorkQueue ?? getVercelConversationWorkQueue(),
  });
  await recoverStaleTimeoutResumes({
    conversationWorkQueue: args.conversationWorkQueue,
    nowMs: args.nowMs,
  });
  await recoverStaleDispatches({ nowMs: args.nowMs });
  await runPluginHeartbeats({ nowMs: args.nowMs });
}
