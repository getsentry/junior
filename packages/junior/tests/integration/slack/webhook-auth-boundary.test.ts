import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

type WaitUntilTask = Promise<unknown>;

function invalidSlackRequest(): Request {
  const body = JSON.stringify({ type: "event_callback" });
  return new Request("https://example.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=invalid",
    },
    body,
  });
}

function collectWaitUntil(tasks: WaitUntilTask[]) {
  return (task: WaitUntilTask | (() => WaitUntilTask)) => {
    tasks.push(typeof task === "function" ? task() : task);
  };
}

describe("Slack webhook auth boundary", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_SIGNING_SECRET: "test-signing-secret",
    };
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("rejects invalid Slack signatures before durable state is required", async () => {
    const { handlePlatformWebhook } = await import("@/handlers/webhooks");
    const waitUntilTasks: WaitUntilTask[] = [];

    const response = await handlePlatformWebhook(
      invalidSlackRequest(),
      "slack",
      collectWaitUntil(waitUntilTasks),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(waitUntilTasks).toHaveLength(0);
  });
});
