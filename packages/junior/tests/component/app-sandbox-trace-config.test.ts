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

describe("sandbox egress route trace config", () => {
  it("passes configured egress trace domains to sandbox egress routes", async () => {
    const { normalizeSandboxEgressTracePropagationDomains } =
      await import("@/chat/sandbox/egress/tracing");
    const { handleSandboxEgressRoute } =
      await import("@/handlers/sandbox-egress-route");

    const response = await handleSandboxEgressRoute(
      new Request("https://junior.example.com/proxied"),
      normalizeSandboxEgressTracePropagationDomains(["*.SENTRY.IO"]),
      vi.fn(async () => undefined),
    );

    expect(response?.status).toBe(200);
    expect(sandboxEgressProxyMock).toHaveBeenCalledWith(expect.any(Request), {
      tracePropagation: { domains: ["*.sentry.io"] },
    });
  });
});
