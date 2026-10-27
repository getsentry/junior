/** Limit Slack use of Junior to authors on the allowed domains. */
import type { StateAdapter } from "chat";
import { logWarn } from "@/chat/logging";
import { isAllowedDomain } from "@/chat/sign-in/allowlist";
import { parseSlackUserId } from "@/chat/slack/ids";
import { lookupSlackUserProfile } from "@/chat/slack/users";

// Like workspace membership: avoid a lookup per message, and let a changed
// profile email apply within five minutes.
const ALLOWED_TTL_MS = 5 * 60 * 1000;
const NOT_ALLOWED_TTL_MS = 30 * 1000;

/**
 * Return whether a Slack author may start a Turn. With allowed domains, the
 * email of the author's Slack profile must be on one of them. Slack verifies
 * that email, so Junior trusts it. Without allowed domains, every author may.
 */
export async function isSlackAuthorDomainAllowed(args: {
  allowedDomains: readonly string[];
  state: StateAdapter;
  teamId: string | undefined;
  user: unknown;
}): Promise<boolean> {
  if (args.allowedDomains.length === 0) return true;
  const userId = parseSlackUserId(args.user);
  if (!args.teamId || !userId) return false;
  const key = `slack:allowed-domain:${args.teamId}:${userId}`;
  const cached = await args.state.get<boolean>(key);
  if (typeof cached === "boolean") return cached;

  const profile = await lookupSlackUserProfile(userId);
  const email = profile.email?.toLowerCase();
  const separator = email?.lastIndexOf("@") ?? -1;
  const domain = separator > 0 ? email?.slice(separator + 1) : undefined;
  const allowed =
    profile.id === userId && isAllowedDomain(domain, args.allowedDomains);
  if (!allowed) {
    // A Slack app without `users:read.email` sees no email and blocks all.
    logWarn("slack.allowed_domain.rejected", {
      "app.reason": email ? "domain_not_allowed" : "missing_email",
    });
  }
  await args.state.set(
    key,
    allowed,
    allowed ? ALLOWED_TTL_MS : NOT_ALLOWED_TTL_MS,
  );
  return allowed;
}
