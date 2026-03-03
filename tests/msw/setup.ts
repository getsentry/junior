import { afterAll, afterEach, beforeAll } from "vitest";
import { resetSlackApiMockState } from "./handlers/slack-api";
import { enforceUnhandledSlackRequestFailure, mswServer } from "./server";

// MSW is enabled globally for both tests and evals. Keep Slack HTTP contract
// assertions in tests/integration and keep evals focused on behavior outcomes.
beforeAll(() => {
  if (!process.env.SLACK_BOT_TOKEN) {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
  }

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
