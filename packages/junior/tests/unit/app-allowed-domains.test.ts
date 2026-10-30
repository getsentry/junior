import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";

afterEach(() => {
  setDashboardConversationLinkOptions(undefined);
  vi.doUnmock("#junior/config");
  vi.unstubAllEnvs();
});

describe("createApp allowed domains", () => {
  it("passes top-level allowedDomains to the dashboard", async () => {
    const createDashboardApp = vi.fn((_options: unknown) => ({
      fetch: () => new Response("dashboard"),
    }));
    vi.doMock("#junior/config", () => ({
      createDashboardApp,
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));

    const app = await createApp({
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
      createDashboardApp: vi.fn(),
      functionMaxDurationSeconds: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));

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
