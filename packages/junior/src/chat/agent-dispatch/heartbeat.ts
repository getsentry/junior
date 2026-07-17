import { getPlugins } from "@/chat/plugins/agent-hooks";
import { logException, logInfo } from "@/chat/logging";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { getVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import type { RecoverableSlackDelivery } from "@/chat/slack/recoverable-delivery";
import { recoverDueSlackDeliveries } from "@/chat/runtime/slack-delivery-recovery";
import { createHeartbeatContext } from "./context";
import { scheduleDispatchCallback } from "./signing";
import {
  getDispatchConversationId,
  getDispatchStorageKey,
  getDispatchRecord,
  getDispatchTurnId,
  isTerminalDispatchStatus,
  listIncompleteDispatchIds,
  parseDispatchRecord,
  updateDispatchRecord,
  withDispatchLock,
} from "./store";
import type { DispatchRecord } from "./types";
import { recoverAuthorizationCompletedAgentTurns } from "@/chat/services/agent-continue";

const DEFAULT_RECOVERY_LIMIT = 25;
const DEFAULT_PLUGIN_LIMIT = 25;
const DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 25_000;

function isStaleDispatch(args: {
  nowMs: number;
  record: {
    lastCallbackAtMs?: number;
    leaseExpiresAtMs?: number;
    nextCallbackKind?: "delivery";
    nextCallbackAtMs?: number;
    status: string;
  };
}): boolean {
  if (args.record.status === "running") {
    return (
      typeof args.record.leaseExpiresAtMs === "number" &&
      args.record.leaseExpiresAtMs <= args.nowMs
    );
  }
  if (
    args.record.status === "awaiting_resume" &&
    args.record.nextCallbackKind === "delivery"
  ) {
    return (
      typeof args.record.nextCallbackAtMs !== "number" ||
      args.record.nextCallbackAtMs <= args.nowMs
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

/** Re-drive stale core dispatches before invoking plugin heartbeat hooks. */
export async function recoverStaleDispatches(args: {
  limit?: number;
  nowMs: number;
  recoverableSlackDelivery?: RecoverableSlackDelivery;
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
      let recoveryRecord = record;
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
      if (
        record.nextCallbackKind !== "delivery" &&
        record.attempt >= record.maxAttempts
      ) {
        const canonicalTerminal =
          await args.recoverableSlackDelivery?.loadTerminalOutcome({
            conversationId: getDispatchConversationId(record),
            turnId: getDispatchTurnId(record.id),
            acceptanceEvidence: "known_outbox_intent",
          });
        if (!canonicalTerminal) {
          await failDispatch({
            record,
            errorMessage: "Dispatch exceeded retry attempts.",
          });
          continue;
        }
        const terminalRecovery = await withDispatchLock(
          record.id,
          async (state) => {
            const current = parseDispatchRecord(
              await state.get(getDispatchStorageKey(record.id)),
            );
            if (!current || current.version !== record.version) {
              return undefined;
            }
            return await updateDispatchRecord(state, {
              ...current,
              leaseExpiresAtMs: undefined,
              nextCallbackAtMs: args.nowMs,
              nextCallbackKind: "delivery",
              status: "awaiting_resume",
            });
          },
        );
        if (!terminalRecovery) {
          continue;
        }
        recoveryRecord = terminalRecovery;
      }
      await scheduleDispatchCallback({
        id: recoveryRecord.id,
        expectedVersion: recoveryRecord.version,
        ...(recoveryRecord.nextCallbackKind === "delivery"
          ? { kind: "delivery" as const }
          : {}),
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
        logInfo(
          "plugin_heartbeat_dispatched",
          {},
          {
            "app.dispatch.count": result.dispatchCount,
            "app.plugin.name": pluginName,
          },
          "Plugin heartbeat dispatched agent work",
        );
      }
    } catch (error) {
      logException(
        error,
        "plugin_heartbeat_failed",
        {},
        { "app.plugin.name": pluginName },
        "Plugin heartbeat failed",
      );
    }
  }
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: {
  conversationWorkQueue?: ConversationWorkQueue;
  nowMs: number;
  recoverableSlackDelivery?: RecoverableSlackDelivery;
}): Promise<void> {
  const conversationWorkQueue =
    args.conversationWorkQueue ?? getVercelConversationWorkQueue();
  await recoverAuthorizationCompletedAgentTurns({
    nowMs: args.nowMs,
    queue: conversationWorkQueue,
  });
  await recoverConversationWork({
    nowMs: args.nowMs,
    queue: conversationWorkQueue,
  });
  if (args.recoverableSlackDelivery) {
    await recoverDueSlackDeliveries({
      delivery: args.recoverableSlackDelivery,
      nowMs: args.nowMs,
    });
  }
  await recoverStaleDispatches({
    nowMs: args.nowMs,
    recoverableSlackDelivery: args.recoverableSlackDelivery,
  });
  await runPluginHeartbeats({ nowMs: args.nowMs });
}
