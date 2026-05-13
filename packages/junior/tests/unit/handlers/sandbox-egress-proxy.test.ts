import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { issueProviderCredentialLeaseMock } = vi.hoisted(() => ({
  issueProviderCredentialLeaseMock: vi.fn(),
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/plugins/registry", () => ({
  getPluginProviders: () => [
    {
      manifest: {
        name: "sentry",
        description: "Sentry",
        capabilities: ["sentry.api"],
        configKeys: [],
        credentials: {
          type: "oauth-bearer",
          apiDomains: ["sentry.io"],
          authTokenEnv: "SENTRY_AUTH_TOKEN",
          authTokenPlaceholder: "host_managed_credential",
        },
      },
    },
  ],
}));

vi.mock("@/chat/capabilities/factory", () => ({
  issueProviderCredentialLease: issueProviderCredentialLeaseMock,
}));

import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress-policy";
import { upsertSandboxEgressSession } from "@/chat/sandbox/egress-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  proxySandboxEgressRequest,
  validateVercelSandboxOidcClaims,
} from "@/handlers/sandbox-egress-proxy";

describe("sandbox egress proxy", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    issueProviderCredentialLeaseMock.mockReset();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_TEAM_ID;
    vi.restoreAllMocks();
  });

  it("builds provider forwarding policy for sandbox egress", () => {
    expect(buildSandboxEgressNetworkPolicy("junior-sbx")).toEqual({
      allow: {
        "*": [],
        "sentry.io": [
          {
            forwardURL:
              "https://junior.example.com/api/internal/sandbox-egress/junior-sbx",
          },
        ],
      },
    });
  });

  it("forwards authorized sandbox requests with provider headers and rejects exact replays", async () => {
    await upsertSandboxEgressSession({
      sandboxId: "junior-sbx",
      requesterId: "U123",
      providers: ["sentry"],
      ttlMs: 60_000,
    });
    issueProviderCredentialLeaseMock.mockResolvedValue({
      id: "lease-1",
      provider: "sentry",
      env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
      headerTransforms: [
        {
          domain: "sentry.io",
          headers: { Authorization: "Bearer sentry-token" },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://sentry.io/api/0/issues/?query=foo");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      return new Response("ok", { status: 200 });
    });

    const request = new Request(
      "https://junior.example.com/api/internal/sandbox-egress/junior-sbx/api/0/issues/?query=foo",
      {
        method: "GET",
        headers: {
          "vercel-forwarded-host": "sentry.io",
          "vercel-forwarded-scheme": "https",
          "vercel-sandbox-oidc-token": "signed-token",
        },
      },
    );

    const response = await proxySandboxEgressRequest(request, "junior-sbx", {
      fetch: fetchMock as typeof fetch,
      verifyOidc: async () => ({ sub: "sandbox" }),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      provider: "sentry",
      requesterId: "U123",
      reason: "sandbox-egress:sentry",
    });

    const replay = await proxySandboxEgressRequest(
      new Request(request.url, {
        method: "GET",
        headers: request.headers,
      }),
      "junior-sbx",
      {
        fetch: fetchMock as typeof fetch,
        verifyOidc: async () => ({ sub: "sandbox" }),
      },
    );

    expect(replay.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects provider requests when the sandbox session did not authorize that provider", async () => {
    await upsertSandboxEgressSession({
      sandboxId: "junior-sbx",
      requesterId: "U123",
      providers: ["github"],
      ttlMs: 60_000,
    });

    const response = await proxySandboxEgressRequest(
      new Request(
        "https://junior.example.com/api/internal/sandbox-egress/junior-sbx/api/0/issues/",
        {
          method: "GET",
          headers: {
            "vercel-forwarded-host": "sentry.io",
            "vercel-sandbox-oidc-token": "signed-token",
          },
        },
      ),
      "junior-sbx",
      {
        fetch: vi.fn() as typeof fetch,
        verifyOidc: async () => ({ sub: "sandbox" }),
      },
    );

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("requires OIDC claims to match the Vercel project and sandbox", () => {
    process.env.VERCEL_PROJECT_ID = "prj_123";
    process.env.VERCEL_TEAM_ID = "team_123";

    expect(() =>
      validateVercelSandboxOidcClaims(
        {
          owner_id: "team_123",
          project_id: "prj_123",
          sandbox_id: "junior-sbx",
        },
        "junior-sbx",
      ),
    ).not.toThrow();

    expect(() =>
      validateVercelSandboxOidcClaims(
        {
          owner_id: "team_123",
          project_id: "prj_other",
          sandbox_id: "junior-sbx",
        },
        "junior-sbx",
      ),
    ).toThrow("different project");

    expect(() =>
      validateVercelSandboxOidcClaims(
        {
          owner_id: "team_123",
          project_id: "prj_123",
          sandbox_id: "other-sandbox",
        },
        "junior-sbx",
      ),
    ).toThrow("different sandbox");
  });
});
