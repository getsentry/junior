import type {
  HeartbeatHookContext,
  PluginRegistration,
} from "@sentry/junior-plugin-api";
import { bindSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { getPluginDbForRegistration } from "@/chat/plugins/db";
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
): BoundDispatchOptions {
  const { credentialSubject, ...baseOptions } = options;
  if (!credentialSubject) {
    return baseOptions;
  }
  if ("binding" in credentialSubject) {
    throw new Error("Dispatch credentialSubject binding is runtime-owned");
  }

  const boundSubject = bindSlackDirectCredentialSubject({
    channelId: options.destination.channelId,
    teamId: options.destination.teamId,
    subject: credentialSubject,
  });
  if (!boundSubject) {
    throw new Error(
      "Dispatch credentialSubject must match the private direct Slack destination",
    );
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
  const db =
    typeof args.plugin === "string"
      ? undefined
      : getPluginDbForRegistration(args.plugin);
  let dispatchCount = 0;
  return {
    plugin: { name: pluginName },
    nowMs: args.nowMs,
    ...(db ? { db } : {}),
    state: createPluginState(pluginName),
    log: createPluginLogger(pluginName),
    agent: {
      async dispatch(options) {
        validateDispatchOptions(options);
        const dispatchOptions = bindDispatchCredentialSubject(options);
        if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
          throw new Error("Plugin heartbeat exceeded the dispatch limit");
        }
        await verifyDispatchCredentialSubjectAccess(dispatchOptions);
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
