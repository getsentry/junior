import type {
  HeartbeatHookContext,
  PluginRegistration,
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

/** Verify, persist, and enqueue one idempotent agent dispatch. */
async function dispatch(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: BoundDispatchOptions;
  plugin: string;
}) {
  await verifyDispatchCredentialSubjectAccess(args.options, args.plugin);
  const result = await createOrGetDispatch({
    plugin: args.plugin,
    options: args.options,
    nowMs: args.nowMs,
  });
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
        const result = await dispatch({
          conversationWorkQueue: args.conversationWorkQueue,
          nowMs: args.nowMs,
          options: dispatchOptions,
          plugin: pluginName,
        });
        dispatchCount += 1;
        return result;
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

/** Create and enqueue one core-owned event task dispatch. */
export async function dispatchEventTask(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: Omit<SlackDispatchOptions, "credentialSubject"> & {
    credentialSubject?: {
      allowedWhen: "event-task";
      taskId: string;
      type: "user";
      userId: string;
    };
  };
}) {
  const plugin = "junior";
  const { credentialSubject, ...unboundOptions } = args.options;
  validateDispatchOptions({ ...unboundOptions });
  const boundSubject = credentialSubject
    ? bindEventTaskCredentialSubject({
        plugin,
        subject: credentialSubject,
      })
    : undefined;
  if (credentialSubject && !boundSubject) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }
  const options: BoundDispatchOptions = {
    ...unboundOptions,
    ...(boundSubject ? { credentialSubject: boundSubject } : undefined),
  };
  return await dispatch({
    conversationWorkQueue: args.conversationWorkQueue,
    nowMs: args.nowMs,
    options,
    plugin,
  });
}

/** Create and enqueue one core-owned scheduled task dispatch. */
export async function dispatchScheduledTask(args: {
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: Omit<SlackDispatchOptions, "credentialSubject"> & {
    credentialSubject?: {
      allowedWhen: "scheduled-task";
      taskId: string;
      type: "user";
      userId: string;
    };
  };
}) {
  const plugin = "scheduler";
  const { credentialSubject, ...unboundOptions } = args.options;
  validateDispatchOptions({ ...unboundOptions });
  const boundSubject = credentialSubject
    ? bindScheduledTaskCredentialSubject({
        plugin,
        subject: credentialSubject,
      })
    : undefined;
  if (credentialSubject && !boundSubject) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }
  const options: BoundDispatchOptions = {
    ...unboundOptions,
    ...(boundSubject ? { credentialSubject: boundSubject } : undefined),
  };
  return await dispatch({
    conversationWorkQueue: args.conversationWorkQueue,
    nowMs: args.nowMs,
    options,
    plugin,
  });
}

/** Read the bounded outcome for one core-owned scheduled task dispatch. */
export async function getScheduledTaskDispatch(id: string) {
  return await getPluginDispatchProjection({ plugin: "scheduler", id });
}
