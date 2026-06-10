import { afterEach, describe, expect, it, vi } from "vitest";

const { sandboxEgressProxyMock } = vi.hoisted(() => ({
  sandboxEgressProxyMock: vi.fn(async () => new Response("ok")),
}));

vi.mock("@/handlers/sandbox-egress-proxy", () => ({
  ALL: sandboxEgressProxyMock,
  isSandboxEgressRequest: () => true,
}));

afterEach(() => {
  sandboxEgressProxyMock.mockClear();
  vi.resetModules();
});

describe("createApp sandbox trace config", () => {
  it("passes configured egress trace domains to sandbox egress routes", async () => {
    const { createApp, defineJuniorPlugins } = await import("@/app");

    const app = await createApp({
      plugins: defineJuniorPlugins([]),
      sandbox: {
        egressTracePropagationDomains: ["*.SENTRY.IO"],
      },
    });

    const response = await app.fetch(
      new Request("https://junior.example.com/proxied"),
    );

    expect(response.status).toBe(200);
    expect(sandboxEgressProxyMock).toHaveBeenCalledWith(expect.any(Request), {
      tracePropagation: { domains: ["*.sentry.io"] },
    });
  });
});
