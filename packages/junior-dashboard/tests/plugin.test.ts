import { afterEach, describe, expect, it } from "vitest";
import { juniorDashboardPlugin } from "../src/index";

const envNames = [
  "BETTER_AUTH_URL",
  "JUNIOR_BASE_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
] as const;

const originalEnv = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]]),
);

const log = {
  error() {},
  info() {},
  warn() {},
};

afterEach(() => {
  for (const name of envNames) {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("juniorDashboardPlugin", () => {
  it("does not register manifest package config", () => {
    const plugin = juniorDashboardPlugin();

    expect(plugin.name).toBe("dashboard");
    expect(plugin.pluginConfig).toBeUndefined();
  });

  it("provides Slack footer links to dashboard conversation pages", () => {
    const plugin = juniorDashboardPlugin({
      basePath: "/ops",
      baseURL: "https://junior.example.com",
    });

    expect(
      plugin.hooks?.slackConversationLink?.({
        conversationId: "slack:C1:123",
        log,
        plugin: { name: "dashboard" },
      }),
    ).toEqual({
      url: "https://junior.example.com/ops/conversations/slack%3AC1%3A123",
    });
  });

  it("uses the deployment base URL environment when no explicit base URL is provided", () => {
    process.env.JUNIOR_BASE_URL = "junior.example.com";

    const plugin = juniorDashboardPlugin();

    expect(
      plugin.hooks?.slackConversationLink?.({
        conversationId: "slack:D1:123",
        log,
        plugin: { name: "dashboard" },
      }),
    ).toEqual({
      url: "https://junior.example.com/conversations/slack%3AD1%3A123",
    });
  });
});
