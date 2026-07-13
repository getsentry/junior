import type {
  HeartbeatHookContext,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  bindScheduledTaskCredentialSubject,
  bindSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import {
  createOrGetDispatch,
  getPluginDispatchProjection,
  isTerminalDispatchStatus,
} from "./store";
import { scheduleDispatchCallback } from "./signing";
import type {
  BoundDispatchOptions,
  DispatchRecord,
  SlackDispatchOptions,
} from "./types";
import {
  validateDispatchOptions,
  verifyDispatchCredentialSubjectAccess,
} from "./validation";

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

function bindDispatchCredentialSubject(
  options: SlackDispatchOptions,
  plugin: string,
): BoundDispatchOptions {
  const { credentialSubject, ...baseOptions } = options;
  if (!credentialSubject) {
    return baseOptions;
  }
  if ("binding" in credentialSubject) {
    throw new Error("Dispatch credentialSubject binding is runtime-owned");
  }

  const boundSubject =
    credentialSubject.allowedWhen === "scheduled-task"
      ? bindScheduledTaskCredentialSubject({
          plugin,
          subject: credentialSubject,
        })
      : bindSlackDirectCredentialSubject({
          channelId: options.destination.channelId,
          teamId: options.destination.teamId,
          subject: credentialSubject,
        });
  if (!boundSubject) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }

  return {
    ...baseOptions,
    credentialSubject: boundSubject,
  };
}

/** Build the plugin-scoped heartbeat context that gates durable dispatch access. */
export function createHeartbeatContext(args: {
  nowMs: number;
  plugin: string | PluginRegistration;
}): HeartbeatHookContext {
  const pluginName =
    typeof args.plugin === "string" ? args.plugin : args.plugin.manifest.name;
  let dispatchCount = 0;
  return {
    plugin: { name: pluginName },
    nowMs: args.nowMs,
    db: getDb(),
    state: createPluginState(pluginName),
    log: createPluginLogger(pluginName),
    agent: {
      async dispatch(options) {
        validateDispatchOptions(options);
        const dispatchOptions = bindDispatchCredentialSubject(
          options,
          pluginName,
        );
        if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
          throw new Error("Plugin heartbeat exceeded the dispatch limit");
        }
        await verifyDispatchCredentialSubjectAccess(
          dispatchOptions,
          pluginName,
        );
        const result = await createOrGetDispatch({
          plugin: pluginName,
          options: dispatchOptions,
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
          plugin: pluginName,
          id,
        });
      },
    },
  };
}
