import { formatSlackLink } from "@/chat/slack/mrkdwn";

/** User-facing link and guidance for one OAuth authorization attempt. */
export interface OAuthAuthorizationRequest {
  authorizationUrl: string;
  completionText: string;
  label: string;
}

/** Format the private OAuth authorization prompt for Slack delivery. */
export function formatOAuthAuthorizationMessage(
  args: OAuthAuthorizationRequest,
): string {
  return `${formatSlackLink(args.authorizationUrl, args.label)}. ${args.completionText}`;
}
