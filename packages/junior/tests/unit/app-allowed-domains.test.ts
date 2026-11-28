import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { mockBuiltSystemPrompts } from "../fixtures/built-system-prompts";

afterEach(() => {
  vi.doUnmock("#junior/config");
  vi.doUnmock("#junior/system-prompts");
  vi.unstubAllEnvs();
});

describe("createApp allowed domains", () => {
  it("passes top-level allowedDomains to the dashboard", async () => {
    const createDashboardApp = vi.fn((_options: unknown) => ({
      fetch: () => new Response("dashboard"),
    }));
    vi.doMock("#junior/config", () => ({
      botName: "junior",
      createDashboardApp,
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));
    mockBuiltSystemPrompts();

    const { app } = await createApp({
      allowedDomains: [" Sentry.io "],
      dashboard: { authRequired: false },
      plugins: defineJuniorPlugins([]),
    });
    await app.fetch(new Request("http://localhost/"));

    expect(createDashboardApp).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDomains: ["sentry.io"] }),
    );
  });

  it("rejects the removed dashboard.allowedGoogleDomains option", async () => {
    vi.doMock("#junior/config", () => ({
      botName: "junior",
      createDashboardApp: vi.fn(),
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));
    mockBuiltSystemPrompts();

    await expect(
      createApp({
        dashboard: {
          authRequired: false,
          allowedGoogleDomains: ["sentry.io"],
        } as never,
        plugins: defineJuniorPlugins([]),
      }),
    ).rejects.toThrow("dashboard.allowedGoogleDomains was removed");
  });

  it("rejects the removed JUNIOR_DASHBOARD_GOOGLE_DOMAINS variable", async () => {
    vi.stubEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS", "sentry.io");

    await expect(
      createApp({ plugins: defineJuniorPlugins([]) }),
    ).rejects.toThrow("JUNIOR_DASHBOARD_GOOGLE_DOMAINS was removed");
  });
});

describe("createApp dashboard links", () => {
  it("configures Slack footer links from core dashboard options", async () => {
    vi.doMock("#junior/config", () => ({
      botName: "junior",
      createDashboardApp: vi.fn((_options: unknown) => ({
        fetch: () => new Response("dashboard"),
      })),
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));
    mockBuiltSystemPrompts();

    await createApp({
      dashboard: {
        authRequired: false,
        basePath: "/ops",
        baseURL: "https://junior.example.com",
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          url: "https://junior.example.com/ops/conversations/slack%3AC123%3A1700000000.000100",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });
});
