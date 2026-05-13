import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createRemoteJWKSetMock,
  decodeJwtMock,
  issueProviderCredentialLeaseMock,
  jwtVerifyMock,
} = vi.hoisted(() => ({
  createRemoteJWKSetMock: vi.fn(() => async () => null),
  decodeJwtMock: vi.fn(),
  issueProviderCredentialLeaseMock: vi.fn(),
  jwtVerifyMock: vi.fn(),
}));

vi.mock("jose", () => ({
  createRemoteJWKSet: createRemoteJWKSetMock,
  decodeJwt: decodeJwtMock,
  jwtVerify: jwtVerifyMock,
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
          apiDomains: ["sentry.io", "*.sentry.io"],
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

import {
  buildSandboxEgressNetworkPolicy,
  matchesSandboxEgressDomain,
} from "@/chat/sandbox/egress-policy";
import { upsertSandboxEgressSession } from "@/chat/sandbox/egress-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import {
  proxySandboxEgressRequest,
  validateVercelSandboxOidcClaims,
  verifyVercelSandboxOidcToken,
} from "@/handlers/sandbox-egress-proxy";

const SANDBOX_ID = "junior-sbx";
const REQUESTER_ID = "U123";

async function authorizeSandboxEgress(
  providers: string[] = ["sentry"],
  requesterId = REQUESTER_ID,
): Promise<void> {
  await upsertSandboxEgressSession({
    sandboxId: SANDBOX_ID,
    requesterId,
    providers,
    ttlMs: 60_000,
  });
}

function mockSentryLease(domain = "sentry.io", token = "sentry-token"): void {
  issueProviderCredentialLeaseMock.mockResolvedValue({
    id: "lease-1",
    provider: "sentry",
    env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
    headerTransforms: [
      {
        domain,
        headers: { Authorization: `Bearer ${token}` },
      },
    ],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
}

function egressRequest(
  input: {
    host?: string;
    path?: string;
    scheme?: string;
    port?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  return new Request(
    `https://junior.example.com/api/internal/sandbox-egress/${SANDBOX_ID}${input.path ?? "/api/0/issues/"}`,
    {
      method: "GET",
      headers: {
        "vercel-forwarded-host": input.host ?? "sentry.io",
        "vercel-sandbox-oidc-token": "signed-token",
        ...(input.scheme ? { "vercel-forwarded-scheme": input.scheme } : {}),
        ...(input.port ? { "vercel-forwarded-port": input.port } : {}),
        ...(input.headers ?? {}),
      },
    },
  );
}

function proxy(
  request: Request,
  fetchMock: typeof fetch = vi.fn(
    async () => new Response("ok"),
  ) as typeof fetch,
): Promise<Response> {
  return proxySandboxEgressRequest(request, SANDBOX_ID, {
    fetch: fetchMock,
    verifyOidc: async () => ({ sub: "sandbox" }),
  });
}

describe("sandbox egress proxy", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    createRemoteJWKSetMock.mockClear();
    createRemoteJWKSetMock.mockReturnValue(async () => null);
    decodeJwtMock.mockReset();
    issueProviderCredentialLeaseMock.mockReset();
    jwtVerifyMock.mockReset();
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
    expect(matchesSandboxEgressDomain("sentry.io", "*.sentry.io")).toBe(true);
    expect(matchesSandboxEgressDomain("eu.sentry.io", "*.sentry.io")).toBe(
      true,
    );
    expect(buildSandboxEgressNetworkPolicy(SANDBOX_ID)).toEqual({
      allow: {
        "*": [],
        "sentry.io": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${SANDBOX_ID}`,
          },
        ],
        "*.sentry.io": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${SANDBOX_ID}`,
          },
        ],
      },
    });
  });

  it("forwards authorized sandbox requests with provider headers and rejects exact replays", async () => {
    await authorizeSandboxEgress();
    await authorizeSandboxEgress([]);
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://sentry.io/api/0/issues/?query=foo");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      expect(new Headers(init?.headers).get("host")).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const request = egressRequest({
      path: "/api/0/issues/?query=foo",
      scheme: "HTTPS",
      headers: { host: "junior.example.com" },
    });

    const response = await proxy(request, fetchMock as typeof fetch);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      provider: "sentry",
      requesterId: REQUESTER_ID,
      reason: "sandbox-egress:sentry",
    });

    const replay = await proxy(
      new Request(request.url, {
        method: "GET",
        headers: request.headers,
      }),
      fetchMock as typeof fetch,
    );

    expect(replay.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scopes cached credential leases to the requester", async () => {
    await authorizeSandboxEgress();
    issueProviderCredentialLeaseMock
      .mockResolvedValueOnce({
        id: "lease-1",
        provider: "sentry",
        env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer token-u123" },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .mockResolvedValueOnce({
        id: "lease-2",
        provider: "sentry",
        env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer token-u456" },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      return new Response(new Headers(init?.headers).get("authorization"));
    });

    const firstResponse = await proxy(
      egressRequest({ path: "/api/0/issues/1" }),
      fetchMock as typeof fetch,
    );
    await expect(firstResponse.text()).resolves.toBe("Bearer token-u123");

    await authorizeSandboxEgress(["sentry"], "U456");
    const secondResponse = await proxy(
      egressRequest({
        path: "/api/0/issues/2",
        headers: { "vercel-sandbox-oidc-token": "signed-token-2" },
      }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe("Bearer token-u456");

    expect(issueProviderCredentialLeaseMock).toHaveBeenNthCalledWith(1, {
      provider: "sentry",
      requesterId: REQUESTER_ID,
      reason: "sandbox-egress:sentry",
    });
    expect(issueProviderCredentialLeaseMock).toHaveBeenNthCalledWith(2, {
      provider: "sentry",
      requesterId: "U456",
      reason: "sandbox-egress:sentry",
    });
  });

  it("applies wildcard provider header transforms to matching upstream hosts", async () => {
    await authorizeSandboxEgress();
    mockSentryLease("*.sentry.io");

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({ host: "eu.sentry.io" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves repeated upstream response headers", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const upstreamHeaders = new Headers();
    upstreamHeaders.append("set-cookie", "a=1; Path=/");
    upstreamHeaders.append("set-cookie", "b=2; Path=/");

    const response = await proxy(
      egressRequest(),
      vi.fn(
        async () => new Response("ok", { headers: upstreamHeaders }),
      ) as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(
      (
        response.headers as Headers & {
          getSetCookie?: () => string[];
        }
      ).getSetCookie?.(),
    ).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("rejects forwarded hosts with embedded ports", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ host: "sentry.io:8080", port: "443" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects plaintext forwarded schemes before credential injection", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ scheme: "http" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("returns a command-readable auth marker when provider credentials are missing", async () => {
    await authorizeSandboxEgress();
    issueProviderCredentialLeaseMock.mockRejectedValue(
      new CredentialUnavailableError(
        "sentry",
        "No sentry credentials available.",
      ),
    );

    const response = await proxy(egressRequest());

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=sentry 401 unauthorized",
    );
  });

  it("rejects provider requests when the sandbox session did not authorize that provider", async () => {
    await authorizeSandboxEgress(["github"]);

    const response = await proxy(egressRequest());

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
          sandbox_id: SANDBOX_ID,
        },
        SANDBOX_ID,
      ),
    ).not.toThrow();

    expect(() =>
      validateVercelSandboxOidcClaims(
        {
          owner_id: "team_123",
          project_id: "prj_other",
          sandbox_id: SANDBOX_ID,
        },
        SANDBOX_ID,
      ),
    ).toThrow("different project");

    expect(() =>
      validateVercelSandboxOidcClaims(
        {
          owner_id: "team_123",
          project_id: "prj_123",
          sandbox_id: "other-sandbox",
        },
        SANDBOX_ID,
      ),
    ).toThrow("different sandbox");
  });

  it("caches Vercel OIDC discovery metadata by issuer", async () => {
    process.env.VERCEL_PROJECT_ID = "prj_123";
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/cache-test",
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        project_id: "prj_123",
        sandbox_id: SANDBOX_ID,
      },
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        jwks_uri: "https://oidc.vercel.com/cache-test/jwks",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await verifyVercelSandboxOidcToken("signed-token-1", SANDBOX_ID);
    await verifyVercelSandboxOidcToken("signed-token-2", SANDBOX_ID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
  });
});
