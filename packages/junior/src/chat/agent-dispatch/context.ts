import type { HeartbeatHookContext } from "@sentry/junior-plugin-api";
import { bindSlackDirectCredentialSubject } from "@/chat/credentials/subject";
import { createAgentPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import {
  createOrGetDispatch,
  getPluginDispatchProjection,
  isTerminalDispatchStatus,
} from "./store";
import { scheduleDispatchCallback } from "./signing";
import type {
  BoundDispatchOptions,
  DispatchOptions,
  DispatchRecord,
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
  options: DispatchOptions,
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
        const dispatchOptions = bindDispatchCredentialSubject(options);
        if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
          throw new Error("Plugin heartbeat exceeded the dispatch limit");
        }
        await verifyDispatchCredentialSubjectAccess(dispatchOptions);
        const result = await createOrGetDispatch({
          plugin: args.plugin,
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
          plugin: args.plugin,
          id,
        });
      },
    },
  };
}
