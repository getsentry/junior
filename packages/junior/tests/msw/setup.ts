import { afterAll, afterEach, beforeAll } from "vitest";
import { resetSlackApiMockState } from "./handlers/slack-api";
import { enforceUnhandledSlackRequestFailure, mswServer } from "./server";

// Force test-safe Slack credentials at module evaluation time so any test module
// importing bot/chat runtime at top-level sees deterministic values.
process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
process.env.SLACK_BOT_USER_TOKEN = "xoxp-test-token";
process.env.SLACK_SIGNING_SECRET = "test-signing-secret";
process.env.SLACK_CLIENT_ID = "test-client-id";
process.env.SLACK_CLIENT_SECRET = "test-client-secret";
process.env.SLACK_APP_TOKEN = "xapp-test-token";

// MSW is enabled globally for both tests and evals. Keep Slack HTTP contract
// assertions in tests/integration and keep evals focused on behavior outcomes.
beforeAll(() => {
  mswServer.listen({
    onUnhandledRequest(request) {
      enforceUnhandledSlackRequestFailure(request);
    }
  });
});

afterEach(() => {
  mswServer.resetHandlers();
  resetSlackApiMockState();
});

afterAll(() => {
  mswServer.close();
});
