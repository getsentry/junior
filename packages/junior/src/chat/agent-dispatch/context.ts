import type { HeartbeatHookContext } from "@sentry/junior-plugin-api";
import { createAgentPluginLogger } from "@/chat/plugins/logging";
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

/** Build the plugin-scoped heartbeat context that gates durable dispatch access. */
export function createHeartbeatContext(args: {
  legacyStatePrefixes?: string[];
  nowMs: number;
  plugin: string;
}): HeartbeatHookContext {
  let dispatchCount = 0;
  return {
    plugin: { name: args.plugin },
    nowMs: args.nowMs,
    state: createPluginState(args.plugin, {
      legacyStatePrefixes: args.legacyStatePrefixes,
    }),
    log: createAgentPluginLogger(args.plugin),
    agent: {
      async dispatch(options) {
        validateDispatchOptions(options);
        if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
          throw new Error("Plugin heartbeat exceeded the dispatch limit");
        }
        const result = await createOrGetDispatch({
          plugin: args.plugin,
          options,
          nowMs: args.nowMs,
        });
        dispatchCount += 1;
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
