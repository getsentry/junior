import { getAgentPlugins } from "@/chat/plugins/agent-hooks";
import { logException, logInfo } from "@/chat/logging";
import { createHeartbeatContext } from "./context";
import { scheduleDispatchCallback } from "./signing";
import {
  getDispatchStorageKey,
  getDispatchRecord,
  isTerminalDispatchStatus,
  listIncompleteDispatchIds,
  updateDispatchRecord,
  withDispatchLock,
} from "./store";
import type { DispatchRecord } from "./types";

const DEFAULT_RECOVERY_LIMIT = 25;
const DEFAULT_PLUGIN_LIMIT = 25;
const DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 25_000;

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
      (await state.get<DispatchRecord>(
        getDispatchStorageKey(args.record.id),
      )) ?? args.record;
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

/** Run trusted plugin heartbeat hooks with bounded per-invocation work. */
export async function runTrustedPluginHeartbeats(args: {
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
              legacyStatePrefixes: plugin.pluginConfig?.legacyStatePrefixes,
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
          "trusted_plugin_heartbeat_dispatched",
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
        "trusted_plugin_heartbeat_failed",
        {},
        { "app.plugin.name": plugin.name },
        "Trusted plugin heartbeat failed",
      );
    }
  }
}

/** Run the core heartbeat phases. */
export async function runHeartbeat(args: { nowMs: number }): Promise<void> {
  await recoverStaleDispatches({ nowMs: args.nowMs });
  await runTrustedPluginHeartbeats({ nowMs: args.nowMs });
}
