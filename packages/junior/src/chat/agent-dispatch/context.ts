import type {
  HeartbeatHookContext,
  PluginRegistration,
  DispatchOptions,
  DispatchResult,
} from "@sentry/junior-plugin-api";
import {
  bindEventTaskCredentialSubject,
  bindScheduledTaskCredentialSubject,
  bindSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { getDb } from "@/chat/db";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginState } from "@/chat/plugins/state";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  createOrGetDispatch,
  getPluginDispatchProjection,
  isTerminalDispatchStatus,
} from "./store";
import { enqueueAgentDispatch } from "./work";
import type { BoundDispatchOptions, SlackDispatchOptions } from "./types";
import {
  validateDispatchOptions,
  verifyDispatchCredentialSubjectAccess,
} from "./validation";

const MAX_DISPATCHES_PER_HEARTBEAT = 25;

type EventTaskDispatchResult =
  | DispatchResult
  | (DispatchResult & { deliveryError: unknown });

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
      : credentialSubject.allowedWhen === "event-task"
        ? bindEventTaskCredentialSubject({
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
  conversationWorkQueue: ConversationWorkQueue;
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
        if (!isTerminalDispatchStatus(result.record.status)) {
          await enqueueAgentDispatch(result.record, {
            queue: args.conversationWorkQueue,
            nowMs: args.nowMs,
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

/** Create one core-owned dispatch and preserve queue failure after persistence. */
export async function dispatchEventTask(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: DispatchOptions;
}): Promise<EventTaskDispatchResult> {
  const plugin = "junior";
  validateDispatchOptions(args.options);
  const options = bindDispatchCredentialSubject(args.options, plugin);
  await verifyDispatchCredentialSubjectAccess(options, plugin);
  const result = await createOrGetDispatch({
    plugin,
    options,
    nowMs: args.nowMs,
  });
  if (!isTerminalDispatchStatus(result.record.status)) {
    try {
      await enqueueAgentDispatch(result.record, {
        queue: args.conversationWorkQueue,
        nowMs: args.nowMs,
      });
    } catch (deliveryError) {
      return {
        deliveryError,
        id: result.record.id,
        status: result.status,
      };
    }
  }
  return {
    id: result.record.id,
    status: result.status,
  };
}
