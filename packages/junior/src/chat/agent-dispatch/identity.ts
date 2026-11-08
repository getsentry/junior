import {
  identityDispatchOptionsSchema,
  type IdentityDispatchOptions,
  type IdentityDispatchResult,
} from "@sentry/junior-plugin-api";
import {
  createAndEnqueueConversation,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import { createEventTeamIdResolver } from "@/chat/events/workspace";
import {
  findLinkedSlackMember,
  findSlackMemberByVerifiedEmail,
} from "@/chat/identities/linked-slack-member";
import { logInfo } from "@/chat/logging";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";

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
    const teamId = await resolveSlackTeamId();
    if (!teamId) {
      return notLinked(plugin, "no_slack_bot");
    }
    const member =
      "subjectId" in request
        ? await findLinkedSlackMember({
            allowedDomains: args.allowedDomains,
            provider: plugin,
            providerSubjectId: request.subjectId,
            slackTeamId: teamId,
          })
        : await findSlackMemberByVerifiedEmail({
            allowedDomains: args.allowedDomains,
            // The schema accepts only a valid address, so lowercase is the
            // whole normalization.
            email: request.verifiedEmail.toLowerCase(),
            slackTeamId: teamId,
          });
    if (member.status === "not_linked") {
      return notLinked(plugin, member.reason);
    }

    const accepted = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(member.user),
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
