/** Limit Slack use of Junior to Trusted authors. */
import type { StateAdapter } from "chat";
import { decideAuthorTrust } from "@/chat/identities/trust";
import { createCache } from "@/chat/state/cache";
import { parseSlackUserId } from "@/chat/slack/ids";

// Like workspace membership: avoid a lookup per message, and let a changed
// profile email apply within five minutes.
const ALLOWED_TTL_MS = 5 * 60 * 1000;
const NOT_ALLOWED_TTL_MS = 30 * 1000;

/**
 * Return whether a Slack author may start a Turn: whether core trusts this
 * workspace member (`decideAuthorTrust`). The caller must have checked that
 * the author is a member of the workspace. The allowed bot user IDs are the
 * Slack list of trusted authors, because bots have no profile email.
 */
export async function isSlackAuthorTrusted(args: {
  allowedBotUserIds: readonly string[];
  allowedDomains: readonly string[];
  state: StateAdapter;
  teamId: string | undefined;
  user: unknown;
}): Promise<boolean> {
  const userId = parseSlackUserId(args.user);
  if (!userId) return false;
  const decide = async () =>
    (
      await decideAuthorTrust(
        {
          kind: "slack_member",
          listed: args.allowedBotUserIds.includes(userId),
          userId,
        },
        { allowedDomains: args.allowedDomains, slackTeamId: args.teamId },
      )
    ).trusted;
  if (!args.teamId) return await decide();
  return await createCache(args.state, "core").getOrLoad(
    `slack:allowed-domain:${args.teamId}:${userId}`,
    async () => {
      const allowed = await decide();
      return {
        value: allowed,
        ttlMs: allowed ? ALLOWED_TTL_MS : NOT_ALLOWED_TTL_MS,
      };
    },
  );
}
