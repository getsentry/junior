import type {
  AgentPluginLogger,
  AgentPluginState,
  Dispatch,
  DispatchOptions,
  DispatchResult,
} from "@sentry/junior-plugin-api";
import { logException, logInfo, logWarn } from "@/chat/logging";
import { createPluginState } from "@/chat/plugins/state";
import {
  createOrGetDispatch,
  getPluginDispatchProjection,
  isTerminalDispatchStatus,
} from "./store";
import { scheduleDispatchCallback } from "./signing";
import type { DispatchRecord } from "./types";
import { validateDispatchOptions } from "./validation";

const MAX_DISPATCHES_PER_HEARTBEAT = 25;

function createPluginLogger(plugin: string): AgentPluginLogger {
  return {
    info(message, metadata) {
      logInfo(
        "trusted_plugin_heartbeat_info",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
    warn(message, metadata) {
      logWarn(
        "trusted_plugin_heartbeat_warn",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
    error(message, metadata) {
      logException(
        new Error(message),
        "trusted_plugin_heartbeat_error",
        {},
        { "app.plugin.name": plugin, ...metadata },
        message,
      );
    },
  };
}

function shouldScheduleDispatch(
  record: DispatchRecord,
  nowMs: number,
): boolean {
  if (isTerminalDispatchStatus(record.status)) {
    return false;
  }
  return (
    record.status !== "running" ||
    typeof record.leaseExpiresAtMs !== "number" ||
    record.leaseExpiresAtMs <= nowMs
  );
}

export function createHeartbeatContext(args: {
  nowMs: number;
  plugin: string;
}): {
  agent: {
    dispatch(options: DispatchOptions): Promise<DispatchResult>;
    get(id: string): Promise<Dispatch | undefined>;
  };
  log: AgentPluginLogger;
  nowMs: number;
  state: AgentPluginState;
} {
  let dispatchCount = 0;
  return {
    nowMs: args.nowMs,
    state: createPluginState(args.plugin),
    log: createPluginLogger(args.plugin),
    agent: {
      async dispatch(options) {
        if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
          throw new Error("Plugin heartbeat exceeded the dispatch limit");
        }
        dispatchCount += 1;
        validateDispatchOptions(options);
        const result = await createOrGetDispatch({
          plugin: args.plugin,
          options,
          nowMs: args.nowMs,
        });
        if (shouldScheduleDispatch(result.record, args.nowMs)) {
          await scheduleDispatchCallback({
            id: result.record.id,
            expectedVersion: result.record.version,
          });
        }
        return {
          id: result.record.id,
          status: result.status,
        };
      },
      async get(id) {
        return await getPluginDispatchProjection({
          plugin: args.plugin,
          id,
        });
      },
    },
  };
}
