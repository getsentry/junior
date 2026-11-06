import { createPluginCache } from "@/chat/plugins/cache";
import {
  identityDispatchOptionsSchema,
  type HeartbeatHookContext,
  type IdentityDispatchOptions,
  type IdentityDispatchResult,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  bindEventAutomationCredentialSubject,
  bindScheduledAutomationCredentialSubject,
  bindSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { getDb, getSqlExecutor } from "@/chat/db";
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUserId,
  findSlackUserIdByPrimaryEmail,
} from "@/chat/identities/sql";
import { isSlackProfileDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { logInfo } from "@/chat/logging";
import { createPluginLogger } from "@/chat/plugins/logging";
import { createPluginEmbedder } from "@/chat/plugins/model";
import { createPluginState } from "@/chat/plugins/state";
import { parseSlackUserId } from "@/chat/slack/ids";
import { openSlackDirectMessage } from "@/chat/slack/outbound";
import { lookupActiveSlackWorkspaceMember } from "@/chat/slack/users";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import {
  buildDispatchId,
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
    return { ...baseOptions, source: { kind: "plugin_dispatch" } };
  }
  if ("binding" in credentialSubject) {
    throw new Error("Dispatch credentialSubject binding is runtime-owned");
  }

  const boundSubject =
    credentialSubject.allowedWhen === "scheduled-automation"
      ? bindScheduledAutomationCredentialSubject({
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
    source: { kind: "plugin_dispatch" },
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
  dispatchForIdentity: IdentityDispatcher;
  nowMs: number;
  plugin: string | PluginRegistration;
}): HeartbeatHookContext {
  const pluginName =
    typeof args.plugin === "string" ? args.plugin : args.plugin.manifest.name;
  let dispatchCount = 0;
  const assertDispatchBudget = () => {
    if (dispatchCount >= MAX_DISPATCHES_PER_HEARTBEAT) {
      throw new Error("Plugin heartbeat exceeded the dispatch limit");
    }
  };
  return {
    plugin: { name: pluginName },
    cache: createPluginCache(pluginName),
    nowMs: args.nowMs,
    db: getDb(),
    embedder: createPluginEmbedder(pluginName),
    state: createPluginState(pluginName),
    log: createPluginLogger(pluginName),
    agent: {
      async dispatch(options) {
        validateDispatchOptions(options);
        const dispatchOptions = bindDispatchCredentialSubject(
          options,
          pluginName,
        );
        assertDispatchBudget();
        const result = await dispatch({
          conversationWorkQueue: args.conversationWorkQueue,
          nowMs: args.nowMs,
          options: dispatchOptions,
          plugin: pluginName,
        });
        dispatchCount += 1;
        return result;
      },
      async dispatchForIdentity(options) {
        assertDispatchBudget();
        // Count every attempt, so one heartbeat cannot make unbounded Slack
        // lookups for people who do not match.
        dispatchCount += 1;
        return await args.dispatchForIdentity(pluginName, options);
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

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match a `subjectId`.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

/** Start private DM work for one person on behalf of one plugin. */
export type IdentityDispatcher = (
  plugin: string,
  options: IdentityDispatchOptions,
) => Promise<IdentityDispatchResult>;

/**
 * Build the one entry point that starts private DM work for a person whom a
 * plugin names, from a webhook route or a heartbeat.
 *
 * A `subjectId` matches only an Identity of the calling plugin's provider that
 * the OAuth account-linking flow linked. A `verifiedEmail` matches only the
 * User with that primary email, and the Slack profile of the member must still
 * show that email. In both cases the person must map to exactly one Slack user
 * in the bot's workspace who is a current human member on the allowed domains,
 * as for Slack ingress. Without a Slack bot, nothing matches.
 */
export function createIdentityDispatcher(args: {
  allowedDomains: readonly string[];
  conversationWorkQueue: () => ConversationWorkQueue;
}): IdentityDispatcher {
  const resolveSlackTeamId = createEventTeamIdResolver();
  const notLinked = (plugin: string, reason: string) => {
    logInfo("dispatch.identity.not_linked", {
      "app.plugin.name": plugin,
      "app.dispatch.identity.reason": reason,
    });
    return { status: "not_linked" } as const;
  };

  return async (plugin, options) => {
    const request = identityDispatchOptionsSchema.parse(options);
    // The schema accepts only a valid address, so lowercase is the whole
    // normalization.
    const email =
      "verifiedEmail" in request
        ? request.verifiedEmail.toLowerCase()
        : undefined;
    if ("subjectId" in request && isCoreIdentityProvider(plugin)) {
      return notLinked(plugin, "core_provider");
    }
    const teamId = await resolveSlackTeamId();
    if (!teamId) {
      return notLinked(plugin, "no_slack_bot");
    }
    const slackUserId = parseSlackUserId(
      "subjectId" in request
        ? await findLinkedSlackUserId(getSqlExecutor(), {
            provider: plugin,
            providerSubjectId: request.subjectId,
            slackTeamId: teamId,
          })
        : await findSlackUserIdByPrimaryEmail(getSqlExecutor(), {
            normalizedEmail: request.verifiedEmail.toLowerCase(),
            slackTeamId: teamId,
          }),
    );
    if (!slackUserId) {
      return notLinked(plugin, "no_single_link");
    }
    const member = await lookupActiveSlackWorkspaceMember(slackUserId, teamId);
    if (!member) {
      return notLinked(plugin, "inactive_member");
    }
    // A stored primary email can be stale. Slack must still show the address.
    if (email && member.email?.trim().toLowerCase() !== email) {
      return notLinked(plugin, "email_changed");
    }
    if (!isSlackProfileDomainAllowed(member, args.allowedDomains)) {
      return notLinked(plugin, "domain_not_allowed");
    }

    const dispatchOptions: SlackDispatchOptions = {
      idempotencyKey: request.idempotencyKey,
      credentialSubject: {
        type: "user",
        userId: slackUserId,
        allowedWhen: "private-direct-conversation",
      },
      destination: {
        platform: "slack",
        teamId,
        channelId: await openSlackDirectMessage(slackUserId),
      },
      destinationVisibility: "private",
      input: request.input,
      ...(request.replyAttribution
        ? { replyAttribution: request.replyAttribution }
        : undefined),
    };
    validateDispatchOptions(dispatchOptions);
    return await dispatch({
      conversationWorkQueue: args.conversationWorkQueue(),
      nowMs: Date.now(),
      options: bindDispatchCredentialSubject(dispatchOptions, plugin),
      plugin,
    });
  };
}

/** Create and enqueue one core-owned event automation dispatch. */
export async function dispatchEventAutomation(args: {
  automationId: string;
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: Omit<SlackDispatchOptions, "credentialSubject"> & {
    credentialSubject?: {
      allowedWhen: "event-automation";
      taskId: string;
      type: "user";
      userId: string;
    };
  };
}) {
  const plugin = "junior";
  const { credentialSubject, outcomes, ...unboundOptions } = args.options;
  validateDispatchOptions({ ...unboundOptions });
  const boundSubject = credentialSubject
    ? bindEventAutomationCredentialSubject({
        plugin,
        subject: credentialSubject,
      })
    : undefined;
  if (credentialSubject && !boundSubject) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }
  const options: BoundDispatchOptions = {
    ...unboundOptions,
    ...(outcomes !== undefined ? { outcomes } : undefined),
    ...(boundSubject ? { credentialSubject: boundSubject } : undefined),
    source: {
      kind: "event_automation",
      automationId: args.automationId,
      // An event automation run id is its dispatch id.
      automationRunId: buildDispatchId(plugin, unboundOptions.idempotencyKey),
    },
  };
  return await dispatch({
    conversationWorkQueue: args.conversationWorkQueue,
    nowMs: args.nowMs,
    options,
    plugin,
  });
}

/** Create and enqueue one core-owned scheduled automation dispatch. */
export async function dispatchScheduledAutomation(args: {
  automationId: string;
  conversationWorkQueue: ConversationWorkQueue;
  nowMs: number;
  options: Omit<SlackDispatchOptions, "credentialSubject"> & {
    credentialSubject?: {
      allowedWhen: "scheduled-automation";
      taskId: string;
      type: "user";
      userId: string;
    };
  };
}) {
  // Also the signed credential binding label. A rename breaks existing task
  // credentials.
  const plugin = "scheduler";
  const { credentialSubject, outcomes, ...unboundOptions } = args.options;
  validateDispatchOptions({ ...unboundOptions });
  const boundSubject = credentialSubject
    ? bindScheduledAutomationCredentialSubject({
        plugin,
        subject: credentialSubject,
      })
    : undefined;
  if (credentialSubject && !boundSubject) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }
  const options: BoundDispatchOptions = {
    ...unboundOptions,
    ...(outcomes !== undefined ? { outcomes } : undefined),
    ...(boundSubject ? { credentialSubject: boundSubject } : undefined),
    source: {
      kind: "scheduled_automation",
      automationId: args.automationId,
      // A scheduled automation run id is its idempotency key.
      automationRunId: unboundOptions.idempotencyKey,
    },
  };
  return await dispatch({
    conversationWorkQueue: args.conversationWorkQueue,
    nowMs: args.nowMs,
    options,
    plugin,
  });
}

/** Read the bounded outcome for one core-owned scheduled automation dispatch. */
export async function getScheduledAutomationDispatch(id: string) {
  return await getPluginDispatchProjection({ plugin: "scheduler", id });
}
