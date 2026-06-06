import { afterEach, describe, expect, it, vi } from "vitest";
import type { JuniorDashboardRuntimeConfig } from "../src/config";

const config: JuniorDashboardRuntimeConfig = {
  authRequired: false,
  allowedGoogleDomains: [],
  allowedEmails: [],
  trustedOrigins: [],
};

async function loadHandler(
  resolveDashboardConfig: () => Promise<JuniorDashboardRuntimeConfig>,
) {
  const fetch = vi.fn(async () => new Response("ok"));
  const createDashboardApp = vi.fn(() => ({ fetch }));

  vi.doMock("../src/app", () => ({ createDashboardApp }));
  vi.doMock("../src/config", () => ({ resolveDashboardConfig }));

  const mod = await import("../src/handler");
  const handler = mod.default as (event: { req: Request }) => Promise<Response>;

  return { createDashboardApp, fetch, handler };
}

describe("standalone dashboard handler", () => {
  afterEach(() => {
    vi.doUnmock("../src/app");
    vi.doUnmock("../src/config");
    vi.resetModules();
  });

  it("retries dashboard app creation after a config failure", async () => {
    const resolveDashboardConfig = vi
      .fn<() => Promise<JuniorDashboardRuntimeConfig>>()
      .mockRejectedValueOnce(new Error("temporary config failure"))
      .mockResolvedValueOnce(config);

    const { createDashboardApp, handler } = await loadHandler(
      resolveDashboardConfig,
    );

    await expect(
      handler({ req: new Request("http://localhost/") }),
    ).rejects.toThrow("temporary config failure");

    const response = await handler({ req: new Request("http://localhost/") });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(resolveDashboardConfig).toHaveBeenCalledTimes(2);
    expect(createDashboardApp).toHaveBeenCalledTimes(1);
  });

  it("shares one pending dashboard app creation across concurrent requests", async () => {
    let resolveConfig: (value: JuniorDashboardRuntimeConfig) => void;
    const resolveDashboardConfig = vi.fn(
      () =>
        new Promise<JuniorDashboardRuntimeConfig>((resolve) => {
          resolveConfig = resolve;
        }),
    );
    const { createDashboardApp, handler } = await loadHandler(
      resolveDashboardConfig,
    );

    const first = handler({ req: new Request("http://localhost/") });
    const second = handler({ req: new Request("http://localhost/") });

    resolveConfig!(config);

    await expect(first).resolves.toHaveProperty("status", 200);
    await expect(second).resolves.toHaveProperty("status", 200);
    expect(resolveDashboardConfig).toHaveBeenCalledTimes(1);
    expect(createDashboardApp).toHaveBeenCalledTimes(1);
  });
});
