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
        envVars: {
          SENTRY_BOT_EMAIL: {},
        },
        commandEnv: {
          SENTRY_AUTHOR_EMAIL: "${SENTRY_BOT_EMAIL}",
          SENTRY_READ_ONLY: "1",
        },
        credentials: {
          type: "oauth-bearer",
          domains: ["sentry.io", "us.sentry.io"],
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
  resolveSandboxCommandEnvironment,
} from "@/chat/sandbox/egress-policy";
import { verifyVercelSandboxOidcToken } from "@/chat/sandbox/egress-oidc";
import {
  isSandboxEgressForwardedRequest,
  proxySandboxEgressRequest,
} from "@/chat/sandbox/egress-proxy";
import { upsertSandboxEgressSession } from "@/chat/sandbox/egress-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { ALL } from "@/handlers/sandbox-egress-proxy";

const EGRESS_ID = "junior-sbx";
const REQUESTER_ID = "U123";

async function authorizeSandboxEgress(
  requesterId = REQUESTER_ID,
): Promise<void> {
  await upsertSandboxEgressSession({
    egressId: EGRESS_ID,
    requesterId,
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
    method?: string;
    path?: string;
    scheme?: string | null;
    port?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Request {
  return new Request(
    `https://junior.example.com${input.path ?? "/api/0/issues/"}`,
    {
      method: input.method ?? "GET",
      headers: {
        "vercel-forwarded-host": input.host ?? "sentry.io",
        ...(input.scheme === null
          ? {}
          : { "vercel-forwarded-scheme": input.scheme ?? "https" }),
        "vercel-sandbox-oidc-token": "signed-token",
        ...(input.port ? { "vercel-forwarded-port": input.port } : {}),
        ...(input.headers ?? {}),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
    },
  );
}

function proxy(
  request: Request,
  fetchMock: typeof fetch = vi.fn(
    async () => new Response("ok"),
  ) as typeof fetch,
): Promise<Response> {
  return proxySandboxEgressRequest(request, {
    fetch: fetchMock,
    verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
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
    delete process.env.SENTRY_BOT_EMAIL;
    vi.restoreAllMocks();
  });

  it("builds provider forwarding policy for sandbox egress", () => {
    expect(matchesSandboxEgressDomain("SENTRY.IO", "sentry.io")).toBe(true);
    expect(matchesSandboxEgressDomain("eu.sentry.io", "sentry.io")).toBe(false);
    expect(buildSandboxEgressNetworkPolicy()).toEqual({
      allow: {
        "*": [],
        "sentry.io": [
          {
            forwardURL: "https://junior.example.com/",
          },
        ],
        "us.sentry.io": [
          {
            forwardURL: "https://junior.example.com/",
          },
        ],
      },
    });
  });

  it("fails sandbox egress policy setup without a public callback URL", () => {
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

    expect(() => buildSandboxEgressNetworkPolicy()).toThrow(
      "Cannot determine base URL for sandbox credential egress",
    );
  });

  it("resolves command env for registered sandbox providers", async () => {
    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("resolves command env for a single active sandbox provider", async () => {
    await expect(resolveSandboxCommandEnvironment("sentry")).resolves.toEqual({
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
    await expect(resolveSandboxCommandEnvironment("github")).resolves.toEqual(
      {},
    );
  });

  it("resolves host env bindings for sandbox commands", async () => {
    process.env.SENTRY_BOT_EMAIL = "123+sentry[bot]@users.noreply.github.com";

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      SENTRY_AUTHOR_EMAIL: "123+sentry[bot]@users.noreply.github.com",
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("requires OIDC before forwarded routing details", async () => {
    const response = await ALL(
      new Request("https://junior.example.com/api/0/issues/"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Missing Vercel Sandbox OIDC token",
    });
  });

  it("forwards repeated authorized sandbox requests with credential headers", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://sentry.io/api/0/issues/?query=foo");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      expect(new Headers(init?.headers).get("cookie")).toBe("session=sandbox");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("sandbox-key");
      expect(new Headers(init?.headers).get("x-forwarded-for")).toBe(
        "127.0.0.1",
      );
      expect(new Headers(init?.headers).get("host")).toBeNull();
      expect(
        new Headers(init?.headers).get("vercel-sandbox-oidc-token"),
      ).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const request = egressRequest({
      path: "/api/0/issues/?query=foo",
      scheme: "HTTPS",
      headers: {
        authorization: "Bearer sandbox-token",
        cookie: "session=sandbox",
        host: "junior.example.com",
        "x-api-key": "sandbox-key",
        "x-forwarded-for": "127.0.0.1",
      },
    });

    const response = await proxy(request, fetchMock as typeof fetch);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      provider: "sentry",
      requesterId: REQUESTER_ID,
      reason: "sandbox-egress:sentry",
    });

    const repeated = await proxy(
      new Request(request.url, {
        method: "GET",
        headers: request.headers,
      }),
      fetchMock as typeof fetch,
    );

    expect(repeated.status).toBe(200);
    await expect(repeated.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("forwards root-path sandbox proxy requests using the verified OIDC session", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://sentry.io/api/0/issues/?query=forwarded",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      return new Response("ok", { status: 200 });
    });

    const response = await proxySandboxEgressRequest(
      egressRequest({ path: "/api/0/issues/?query=forwarded" }),
      {
        fetch: fetchMock as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      provider: "sentry",
      requesterId: REQUESTER_ID,
      reason: "sandbox-egress:sentry",
    });
  });

  it("prefers Vercel forwarded path over the normalized proxy URL path", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://sentry.io/api/0/organizations/sentry/?query=is%3Aunresolved",
      );
      expect(
        new Headers(init?.headers).get("vercel-forwarded-path"),
      ).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({
        path: "/api/0/organizations/sentry",
        headers: {
          "vercel-forwarded-path":
            "/api/0/organizations/sentry/?query=is%3Aunresolved",
        },
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("recognizes root-path forwarded sandbox proxy requests", () => {
    expect(isSandboxEgressForwardedRequest(egressRequest())).toBe(true);
    expect(
      isSandboxEgressForwardedRequest(
        new Request("https://junior.example.com/api/0/issues/", {
          headers: {
            "vercel-forwarded-host": "sentry.io",
            "vercel-forwarded-scheme": "https",
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not synthesize an empty body for bodyless methods", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      expect(init).not.toHaveProperty("body");
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({ method: "DELETE" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
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

    await authorizeSandboxEgress("U456");
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

  it("does not reuse cached credential leases across renewed egress sessions", async () => {
    await authorizeSandboxEgress();
    issueProviderCredentialLeaseMock
      .mockResolvedValueOnce({
        id: "lease-1",
        provider: "sentry",
        env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer token-first-session" },
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
            headers: { Authorization: "Bearer token-second-session" },
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
    await expect(firstResponse.text()).resolves.toBe(
      "Bearer token-first-session",
    );

    await authorizeSandboxEgress();
    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe(
      "Bearer token-second-session",
    );

    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("clears cached credential leases after upstream auth rejection", async () => {
    await authorizeSandboxEgress();
    issueProviderCredentialLeaseMock
      .mockResolvedValueOnce({
        id: "lease-1",
        provider: "sentry",
        env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
        headerTransforms: [
          {
            domain: "sentry.io",
            headers: { Authorization: "Bearer stale-token" },
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
            headers: { Authorization: "Bearer fresh-token" },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Bad credentials", { status: 401 }))
      .mockImplementationOnce(
        async (_url: URL | string, init?: RequestInit) =>
          new Response(new Headers(init?.headers).get("authorization")),
      );

    const firstResponse = await proxy(
      egressRequest({ path: "/api/0/issues/1" }),
      fetchMock as typeof fetch,
    );
    expect(firstResponse.status).toBe(401);

    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe("Bearer fresh-token");

    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("applies provider header transforms to matching upstream hosts", async () => {
    await authorizeSandboxEgress();
    mockSentryLease("us.sentry.io");

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer sentry-token",
      );
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({ host: "us.sentry.io" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not apply subdomain transforms to the apex host", async () => {
    await authorizeSandboxEgress();
    mockSentryLease("us.sentry.io");

    const fetchMock = vi.fn();

    const response = await proxy(egressRequest(), fetchMock as typeof fetch);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Credential lease does not cover forwarded host",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards upstream response headers to the sandbox", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const upstreamHeaders = new Headers();
    upstreamHeaders.append("set-cookie", "session=provider; Path=/");
    upstreamHeaders.append("x-request-id", "req-123");

    const response = await proxy(
      egressRequest(),
      vi.fn(
        async () => new Response("ok", { headers: upstreamHeaders }),
      ) as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBe("session=provider; Path=/");
    expect(response.headers.get("x-request-id")).toBe("req-123");
  });

  it("drops upstream encoding headers after host fetch decodes the body", async () => {
    await authorizeSandboxEgress();
    mockSentryLease();

    const response = await proxy(
      egressRequest(),
      vi.fn(
        async () =>
          new Response("ok", {
            headers: {
              "content-encoding": "gzip",
              "content-length": "999",
              "x-request-id": "req-123",
            },
          }),
      ) as typeof fetch,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("req-123");
  });

  it("rejects forwarded hosts with embedded ports", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ host: "sentry.io:8080", port: "443" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded host",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid forwarded ports", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ port: "65536" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded port",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid forwarded paths", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({
        headers: {
          "vercel-forwarded-path": "//evil.example/api/0/issues/",
        },
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid forwarded path",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("requires the verified OIDC token to identify the sandbox session", async () => {
    const fetchMock = vi.fn();

    const response = await proxySandboxEgressRequest(egressRequest(), {
      fetch: fetchMock as typeof fetch,
      verifyOidc: async () => ({ sub: "sandbox" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Vercel Sandbox OIDC token did not include sandbox_id",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects plaintext forwarded schemes before credential injection", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ scheme: "http" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Forwarded scheme must be https",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("requires the Vercel forwarded scheme header", async () => {
    const fetchMock = vi.fn();

    const response = await proxy(
      egressRequest({ scheme: null }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing forwarded scheme",
    });
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

  it("requires a requester-bound sandbox egress session", async () => {
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("caches Vercel OIDC discovery metadata by issuer", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/cache-test",
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sandbox_id: EGRESS_ID,
      },
    });
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      Response.json({
        jwks_uri: "https://oidc.vercel.com/cache-test/jwks",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await verifyVercelSandboxOidcToken("signed-token-1");
    await verifyVercelSandboxOidcToken("signed-token-2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ redirect: "error" });
    expect(createRemoteJWKSetMock).toHaveBeenCalledTimes(1);
  });

  it("verifies sandbox tokens without assuming the deployment OIDC audience", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/acme",
    });
    jwtVerifyMock.mockResolvedValue({
      payload: {
        aud: "sandbox-proxy-audience",
        owner_id: "different-team",
        project_id: "different-project",
        sandbox_id: EGRESS_ID,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jwks_uri: "https://oidc.vercel.com/acme/jwks",
        }),
      ),
    );

    await verifyVercelSandboxOidcToken("signed-token");

    expect(jwtVerifyMock).toHaveBeenCalledWith(
      "signed-token",
      expect.anything(),
      {
        issuer: "https://oidc.vercel.com/acme",
      },
    );
  });

  it("rejects non-HTTPS Vercel OIDC JWKS metadata", async () => {
    decodeJwtMock.mockReturnValue({
      iss: "https://oidc.vercel.com/bad-jwks",
    });
    const fetchMock = vi.fn(async () =>
      Response.json({
        jwks_uri: "http://oidc.vercel.com/bad-jwks/jwks",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyVercelSandboxOidcToken("signed-token")).rejects.toThrow(
      "jwks_uri",
    );

    expect(createRemoteJWKSetMock).not.toHaveBeenCalled();
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });
});
