import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import type { SlackMessageBlock } from "@/chat/slack/footer";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";

/** Present private OAuth authorization with a clear action and text fallback. */
export function buildSlackOAuthAuthorizationMessage(
  args: OAuthAuthorizationRequest,
): { text: string; blocks: SlackMessageBlock[] } {
  return {
    text: `${formatSlackLink(args.authorizationUrl, args.label)}. ${args.completionText}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeSlackMrkdwnText(args.label)}*\n${escapeSlackMrkdwnText(args.completionText)}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Connect" },
          style: "primary",
          url: args.authorizationUrl,
          action_id: "oauth_connect",
        },
      },
    ],
  };
}
