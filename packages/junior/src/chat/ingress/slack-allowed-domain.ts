/** Limit Slack use of Junior to authors on the allowed domains. */
import type { StateAdapter } from "chat";
import { logWarn } from "@/chat/logging";
import { createCache } from "@/chat/state/cache";
import { isAllowedDomain } from "@/chat/sign-in/allowlist";
import { parseSlackUserId } from "@/chat/slack/ids";
import {
  lookupSlackUserProfile,
  type SlackUserProfile,
} from "@/chat/slack/users";

// Like workspace membership: avoid a lookup per message, and let a changed
// profile email apply within five minutes.
const ALLOWED_TTL_MS = 5 * 60 * 1000;
const NOT_ALLOWED_TTL_MS = 30 * 1000;

/**
 * Return whether a Slack author may start a Turn. With allowed domains, the
 * email of the author's Slack profile must be on one of them. Slack verifies
 * that email, so Junior trusts it. Bots have no profile email, so the allowed
 * bot user IDs skip this check. Without allowed domains, every author may.
 */
export async function isSlackAuthorDomainAllowed(args: {
  allowedBotUserIds: readonly string[];
  allowedDomains: readonly string[];
  state: StateAdapter;
  teamId: string | undefined;
  user: unknown;
}): Promise<boolean> {
  if (args.allowedDomains.length === 0) return true;
  const userId = parseSlackUserId(args.user);
  if (!args.teamId || !userId) return false;
  if (args.allowedBotUserIds.includes(userId)) return true;
  return await createCache(args.state, "core").getOrLoad(
    `slack:allowed-domain:${args.teamId}:${userId}`,
    async () => {
      const profile = await lookupSlackUserProfile(userId);
      const allowed =
        profile.id === userId &&
        isSlackProfileDomainAllowed(profile, args.allowedDomains);
      return {
        value: allowed,
        ttlMs: allowed ? ALLOWED_TTL_MS : NOT_ALLOWED_TTL_MS,
      };
    },
  );
}

/**
 * Return whether the email of a Slack profile is on the allowed domains.
 * Without allowed domains, every profile is allowed.
 */
export function isSlackProfileDomainAllowed(
  profile: SlackUserProfile,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  const email = profile.email?.toLowerCase();
  const separator = email?.lastIndexOf("@") ?? -1;
  const domain = separator > 0 ? email?.slice(separator + 1) : undefined;
  const allowed = isAllowedDomain(domain, allowedDomains);
  if (!allowed) {
    // A Slack app without `users:read.email` sees no email and blocks all.
    logWarn("slack.allowed_domain.rejected", {
      "app.reason": email ? "domain_not_allowed" : "missing_email",
    });
  }
  return allowed;
}
