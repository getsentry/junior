import { EVAL_OAUTH_ORIGIN, evalOAuthHandlers } from "./handlers/eval-oauth";
import {
  EVAL_MCP_AUTH_ORIGIN,
  evalMcpAuthHandlers,
} from "./handlers/eval-mcp-auth";
import { allowsLiveTestHttpHost } from "../../../junior-testing/src/http";
import { githubApiHandlers } from "./handlers/github-api";
import { setupServer } from "msw/node";
import { slackApiHandlers } from "./handlers/slack-api";
import { slackWebhookHandlers } from "./handlers/slack-webhooks";

const EVAL_MCP_AUTH_HOSTNAME = new URL(EVAL_MCP_AUTH_ORIGIN).hostname;
const EVAL_OAUTH_HOSTNAME = new URL(EVAL_OAUTH_ORIGIN).hostname;

const HOST_HTTP_FIXTURE_ALLOWLIST = new Set([
  "files.slack.com",
  "slack.com",
  EVAL_MCP_AUTH_HOSTNAME,
  EVAL_OAUTH_HOSTNAME,
]);

export function enforceUnhandledExternalRequestFailure(request: Request): void {
  const url = new URL(request.url);
  if (
    allowsLiveTestHttpHost(url.hostname, {
      juniorBaseUrl: process.env.JUNIOR_BASE_URL,
    }) &&
    !HOST_HTTP_FIXTURE_ALLOWLIST.has(url.hostname)
  ) {
    return;
  }

  throw new Error(
    `[HTTP MOCK] Unhandled external request: ${request.method} ${request.url}`,
  );
}

export const mswServer = setupServer(
  ...slackApiHandlers,
  ...slackWebhookHandlers,
  ...evalMcpAuthHandlers,
  ...evalOAuthHandlers,
  ...githubApiHandlers,
);
