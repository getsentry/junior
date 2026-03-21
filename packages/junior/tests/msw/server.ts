import { EVAL_OAUTH_ORIGIN, evalOAuthHandlers } from "./handlers/eval-oauth";
import {
  EVAL_MCP_AUTH_ORIGIN,
  evalMcpAuthHandlers,
} from "./handlers/eval-mcp-auth";
import { setupServer } from "msw/node";
import { slackApiHandlers } from "./handlers/slack-api";
import { slackWebhookHandlers } from "./handlers/slack-webhooks";

const EVAL_MCP_AUTH_HOSTNAME = new URL(EVAL_MCP_AUTH_ORIGIN).hostname;
const EVAL_OAUTH_HOSTNAME = new URL(EVAL_OAUTH_ORIGIN).hostname;

function isSlackHost(hostname: string): boolean {
  return hostname === "slack.com" || hostname === "files.slack.com";
}

function requiresMockedHandling(hostname: string): boolean {
  return (
    isSlackHost(hostname) ||
    hostname === EVAL_MCP_AUTH_HOSTNAME ||
    hostname === EVAL_OAUTH_HOSTNAME
  );
}

export function enforceUnhandledSlackRequestFailure(request: Request): void {
  const url = new URL(request.url);
  if (!requiresMockedHandling(url.hostname)) {
    return;
  }

  throw new Error(
    `[MSW] Unhandled mocked request: ${request.method} ${request.url}`,
  );
}

export const mswServer = setupServer(
  ...slackApiHandlers,
  ...slackWebhookHandlers,
  ...evalMcpAuthHandlers,
  ...evalOAuthHandlers,
);
