import { resetEvalOAuthMockState } from "./handlers/eval-oauth";
import { resetEvalMcpAuthMockState } from "./handlers/eval-mcp-auth";
import { resetGitHubApiMockState } from "./handlers/github-api";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { resetSlackApiMockState } from "./handlers/slack-api";
import { enforceUnhandledExternalRequestFailure, mswServer } from "./server";

// Force test-safe Slack credentials at module evaluation time so any test module
// importing bot/chat runtime at top-level sees deterministic values.
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.SLACK_BOT_USER_TOKEN = "xoxp-test-token";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_CLIENT_ID = "test-client-id";
process.env.SLACK_CLIENT_SECRET = "test-client-secret";
process.env.SLACK_APP_TOKEN = "xapp-test-token";
process.env.JUNIOR_SECRET = "junior-test-secret";
process.env.EVAL_OAUTH_CLIENT_ID = "eval-oauth-client-id";
process.env.EVAL_OAUTH_CLIENT_SECRET = "eval-oauth-client-secret";

beforeEach(() => {
  process.env.JUNIOR_SECRET = "junior-test-secret";
});

// MSW is enabled globally for both tests and evals. Keep Slack HTTP contract
// assertions in tests/integration and keep evals focused on behavior outcomes.
beforeAll(() => {
  mswServer.listen({
    onUnhandledRequest(request) {
      enforceUnhandledExternalRequestFailure(request);
    },
  });
});

afterEach(() => {
  mswServer.resetHandlers();
  resetEvalOAuthMockState();
  resetEvalMcpAuthMockState();
  resetGitHubApiMockState();
  resetSlackApiMockState();
});

afterAll(() => {
  mswServer.close();
});
