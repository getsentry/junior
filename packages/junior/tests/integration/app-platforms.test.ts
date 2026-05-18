import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@/app";

describe("app platform route wiring", () => {
  const originalSlackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const originalGitHubBotUsername = process.env.GITHUB_BOT_USERNAME;

  afterEach(() => {
    if (originalSlackSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = originalSlackSigningSecret;
    }

    if (originalGitHubBotUsername === undefined) {
      delete process.env.GITHUB_BOT_USERNAME;
    } else {
      process.env.GITHUB_BOT_USERNAME = originalGitHubBotUsername;
    }
  });

  it("does not expose Slack-only routes in a GitHub-only app", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const app = await createApp({ enabledPlatforms: ["github"] });

    expect(
      (
        await app.request("/api/internal/turn-resume", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect((await app.request("/api/oauth/callback/sentry")).status).toBe(404);
    expect(
      (await app.request("/api/oauth/callback/mcp/demo?state=x&code=y")).status,
    ).toBe(404);
  });

  it("rejects disabled webhook platforms before initializing a bot", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.GITHUB_BOT_USERNAME;
    const app = await createApp({ enabledPlatforms: ["github"] });

    const response = await app.request("/api/webhooks/slack", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Unknown platform: slack");
  });

  it("keeps GitHub webhook disabled by default without initializing Slack", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const app = await createApp();

    const response = await app.request("/api/webhooks/github", {
      method: "POST",
      body: "{}",
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Unknown platform: github");
  });
});
