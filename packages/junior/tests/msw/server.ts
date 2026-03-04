import { setupServer } from "msw/node";
import { slackApiHandlers } from "./handlers/slack-api";
import { slackWebhookHandlers } from "./handlers/slack-webhooks";

function isSlackHost(hostname: string): boolean {
  return hostname === "slack.com" || hostname === "files.slack.com";
}

export function enforceUnhandledSlackRequestFailure(request: Request): void {
  const url = new URL(request.url);
  if (!isSlackHost(url.hostname)) {
    return;
  }

  throw new Error(`[MSW] Unhandled Slack request: ${request.method} ${request.url}`);
}

export const mswServer = setupServer(...slackApiHandlers, ...slackWebhookHandlers);
