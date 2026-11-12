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
import { decideAuthorTrust } from "@/chat/identities/trust";
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
 * The person must be a Trusted author with a User (`decideAuthorTrust`): a
 * `subjectId` of the calling plugin's provider that the OAuth account-linking
 * flow linked, or a `verifiedEmail` that is the User's primary email. Without
 * a Slack bot, nothing matches.
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
    const trust = await decideAuthorTrust(
      "subjectId" in request
        ? {
            kind: "account",
            // A plugin can name only an account of its own provider.
            listed: false,
            provider: plugin,
            subjectId: request.subjectId,
          }
        : { kind: "verified_email", email: request.verifiedEmail },
      {
        allowedDomains: args.allowedDomains,
        slackTeamId: await resolveSlackTeamId(),
      },
    );
    if (!trust.trusted) return notLinked(plugin, trust.reason);
    // Both author kinds above resolve through a User.
    if (!trust.user) return notLinked(plugin, "no_single_link");

    const accepted = await createAndEnqueueConversation(
      {
        actor: webActorFromUser(trust.user),
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
