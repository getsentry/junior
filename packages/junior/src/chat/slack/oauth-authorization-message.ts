import { formatSlackLink } from "@/chat/slack/mrkdwn";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";

/** Format the private OAuth authorization prompt for Slack delivery. */
export function formatOAuthAuthorizationMessage(
  args: OAuthAuthorizationRequest,
): string {
  return `${formatSlackLink(args.authorizationUrl, args.label)}. ${args.completionText}`;
}
