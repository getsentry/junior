import { escapeSlackMrkdwnText, formatSlackLink } from "@/chat/slack/mrkdwn";
import type { KnownBlock } from "@slack/types";
import type { OAuthAuthorizationRequest } from "@/chat/oauth-authorization";

// User OAuth links always connect the requester's own account. Say so, because
// provider consent screens often read like an org-wide install.
const ACCOUNT_SCOPE_NOTE =
  "This connects only your account. Junior sees only what you can see.";

/** Present private OAuth authorization with a clear action and text fallback. */
export function buildSlackOAuthAuthorizationMessage(
  args: OAuthAuthorizationRequest,
): { text: string; blocks: KnownBlock[] } {
  return {
    text: `${formatSlackLink(args.authorizationUrl, args.label)}. ${ACCOUNT_SCOPE_NOTE} ${args.completionText}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${escapeSlackMrkdwnText(args.label)}*\n${ACCOUNT_SCOPE_NOTE}\n${escapeSlackMrkdwnText(args.completionText)}`,
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
