import { formatSlackLink } from "@/chat/slack/mrkdwn";

/** Format the private OAuth authorization prompt for Slack delivery. */
export function formatOAuthAuthorizationMessage(args: {
  authorizationUrl: string;
  label: string;
  completionText: string;
}): string {
  return `${formatSlackLink(args.authorizationUrl, args.label)}. ${args.completionText}`;
}
