import {
  identityDispatchOptionsSchema,
  type IdentityDispatchOptions,
  type IdentityDispatchResult,
} from "@sentry/junior-plugin-api";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { getSqlExecutor } from "@/chat/db";
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import { isNativeIdentityProvider } from "@/chat/identities/identity";
import {
  findLinkedSlackUser,
  findSlackUserByPrimaryEmail,
} from "@/chat/identities/sql";
import { isSlackProfileDomainAllowed } from "@/chat/ingress/slack-allowed-domain";
import { logInfo } from "@/chat/logging";
import { parseSlackUserId } from "@/chat/slack/ids";
import { lookupActiveSlackWorkspaceMember } from "@/chat/slack/users";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

// Core owns native identities and the email-keyed `junior` web identities.
// They are not accounts from a plugin's OAuth account-linking flow, so they
// never match a `subjectId`.
function isCoreIdentityProvider(provider: string): boolean {
  return provider === "junior" || isNativeIdentityProvider(provider);
}

/** Start a public web Conversation for one person on behalf of one plugin. */
export type IdentityDispatcher = (
  plugin: string,
  options: IdentityDispatchOptions,
) => Promise<IdentityDispatchResult>;

/**
 * Build the one entry point that starts work for a person whom a plugin
 * names, from a webhook route or a heartbeat.
 *
 * A `subjectId` matches only an Identity of the calling plugin's provider that
 * the OAuth account-linking flow linked. A `verifiedEmail` matches only the
 * User with that primary email, and the Slack profile of the member must still
 * show that email. In both cases the person must map to exactly one Slack user
 * in the bot's workspace who is a current human member on the allowed domains,
 * as for Slack ingress. Without a Slack bot, nothing matches.
 *
 * On a match, the input is that person's first Message in a new public
 * Conversation, as if they sent it from the dashboard. The Conversation has no
 * Slack Destination.
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
    const linked =
      "subjectId" in request
        ? await findLinkedSlackUser(getSqlExecutor(), {
            provider: plugin,
            providerSubjectId: request.subjectId,
            slackTeamId: teamId,
          })
        : await findSlackUserByPrimaryEmail(getSqlExecutor(), {
            normalizedEmail: request.verifiedEmail.toLowerCase(),
            slackTeamId: teamId,
          });
    const slackUserId = parseSlackUserId(linked?.slackUserId);
    if (!linked || !slackUserId) {
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

    const accepted = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(linked.user),
        // Two plugins can send the same key for different work.
        idempotencyKey: `${plugin}:${request.idempotencyKey}`,
        message: request.input,
        visibility: "public",
      },
      { queue: args.conversationWorkQueue() },
    );
    return {
      conversationId: accepted.conversationId,
      status: accepted.status === "duplicate" ? "already_exists" : "created",
    };
  };
}
