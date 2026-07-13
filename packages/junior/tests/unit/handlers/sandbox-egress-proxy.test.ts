import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineJuniorPlugin,
  type IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";

const {
  continueTraceMock,
  getDefinitionMock,
  getOAuthConfigMock,
  getProvidersMock,
  issueProviderCredentialLeaseMock,
  loggerMock,
  startSpanMock,
} = vi.hoisted(() => ({
  continueTraceMock: vi.fn(
    async (_context: unknown, callback: () => Promise<unknown>) =>
      await callback(),
  ),
  getDefinitionMock: vi.fn(),
  getOAuthConfigMock: vi.fn(),
  getProvidersMock: vi.fn(),
  issueProviderCredentialLeaseMock: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
  startSpanMock: vi.fn(
    async (_options: unknown, callback: () => Promise<unknown>) =>
      await callback(),
  ),
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

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getDefinition: getDefinitionMock,
    getOAuthConfig: getOAuthConfigMock,
    getProviders: getProvidersMock,
  },
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({ kind: "user-token-store" }),
  issueProviderCredentialLease: issueProviderCredentialLeaseMock,
}));

vi.mock("@/chat/sentry", () => ({
  continueTrace: continueTraceMock,
  getActiveSpan: () => undefined,
  logger: loggerMock,
  spanToJSON: () => ({}),
  startSpan: startSpanMock,
}));

import {
  buildSandboxEgressNetworkPolicy,
  matchesSandboxEgressDomain,
  resolveSandboxCommandEnvironment,
} from "@/chat/sandbox/egress/policy";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  isSandboxEgressForwardedRequest,
  proxySandboxEgressRequest,
} from "@/chat/sandbox/egress/proxy";
import {
  consumeSandboxEgressPermissionDeniedSignal,
  createSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
} from "@/chat/sandbox/egress/session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { CredentialSubject } from "@/chat/credentials/context";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import { ALL } from "@/handlers/sandbox-egress-proxy";

const EGRESS_ID = "junior-sbx";
const ACTOR_ID = "U123";

let activeCredentialToken: string | undefined;

function sentryPlugin() {
  return {
    manifest: {
      name: "sentry",
      displayName: "Sentry",
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
  };
}

function githubPlugin() {
  return {
    manifest: {
      name: "github",
      displayName: "GitHub",
      description: "GitHub",
      capabilities: ["github.api"],
      configKeys: [],
      envVars: {},
      commandEnv: {
        GITHUB_READ_ONLY: "1",
        GITHUB_TOKEN: "ghp_host_managed_credential",
      },
      domains: ["api.github.com", "github.com"],
    },
  };
}

function headerOnlyPlugin() {
  return {
    manifest: {
      name: "header-only",
      displayName: "Header Only",
      description: "Header-only",
      capabilities: ["header-only.api"],
      configKeys: [],
      envVars: {},
      commandEnv: {
        HEADER_ONLY_READ_ONLY: "1",
      },
      domains: ["api.example.com"],
    },
  };
}

function setSandboxEgressUserActor(userId = ACTOR_ID): void {
  activeCredentialToken = createSandboxEgressCredentialToken({
    credentials: { actor: { type: "user", userId } },
    egressId: EGRESS_ID,
    ttlMs: 60_000,
  });
}

function setSandboxEgressSystemActor(input?: {
  name?: string;
  subject?: CredentialSubject;
}): void {
  activeCredentialToken = createSandboxEgressCredentialToken({
    credentials: {
      actor: { platform: "system", name: input?.name ?? "scheduler" },
      ...(input?.subject ? { subject: input.subject } : {}),
    },
    egressId: EGRESS_ID,
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
    proxyPath?: string;
    forwardedPath?: string | null;
    scheme?: string | null;
    port?: string;
    body?: BodyInit;
    headers?: Record<string, string>;
  } = {},
): Request {
  const upstreamPath = input.path ?? "/api/0/issues/";
  const proxyPath =
    input.proxyPath ??
    (activeCredentialToken
      ? `${SANDBOX_EGRESS_PROXY_PATH}/${activeCredentialToken}`
      : upstreamPath);
  const forwardedPath =
    input.forwardedPath === undefined ? upstreamPath : input.forwardedPath;
  return new Request(`https://junior.example.com${proxyPath}`, {
    method: input.method ?? "GET",
    headers: {
      "vercel-forwarded-host": input.host ?? "sentry.io",
      ...(input.scheme === null
        ? {}
        : { "vercel-forwarded-scheme": input.scheme ?? "https" }),
      "vercel-sandbox-oidc-token": "signed-token",
      ...(forwardedPath !== null
        ? { "vercel-forwarded-path": forwardedPath }
        : {}),
      ...(input.port ? { "vercel-forwarded-port": input.port } : {}),
      ...(input.headers ?? {}),
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

function proxy(
  request: Request,
  fetchMock: typeof fetch = vi.fn(
    async () => new Response("ok"),
  ) as typeof fetch,
  tracePropagation: SandboxEgressTracePropagationConfig = {},
): Promise<Response> {
  return proxySandboxEgressRequest(request, {
    fetch: fetchMock,
    tracePropagation,
    verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
  });
}

describe("sandbox egress proxy", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "test-secret";
    activeCredentialToken = undefined;
    getProvidersMock.mockReturnValue([sentryPlugin()]);
    getDefinitionMock.mockReset();
    getDefinitionMock.mockImplementation((provider: string) =>
      [sentryPlugin(), githubPlugin()].find(
        (plugin) => plugin.manifest.name === provider,
      ),
    );
    getOAuthConfigMock.mockReset();
    getOAuthConfigMock.mockImplementation((provider: string) =>
      provider === "sentry" ? { provider, scope: "project:read" } : undefined,
    );
    issueProviderCredentialLeaseMock.mockReset();
    continueTraceMock.mockClear();
    continueTraceMock.mockImplementation(
      async (_context: unknown, callback: () => Promise<unknown>) =>
        await callback(),
    );
    startSpanMock.mockClear();
    startSpanMock.mockImplementation(
      async (_options: unknown, callback: () => Promise<unknown>) =>
        await callback(),
    );
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    delete process.env.SENTRY_BOT_EMAIL;
    vi.restoreAllMocks();
  });

  it("builds provider forwarding policy for sandbox egress", () => {
    expect(matchesSandboxEgressDomain("SENTRY.IO", "sentry.io")).toBe(true);
    expect(matchesSandboxEgressDomain("eu.sentry.io", "sentry.io")).toBe(false);
    const token = createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: ACTOR_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    expect(buildSandboxEgressNetworkPolicy({ credentialToken: token })).toEqual(
      {
        allow: {
          "*": [],
          "sentry.io": [
            {
              forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
            },
          ],
          "us.sentry.io": [
            {
              forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
            },
          ],
        },
      },
    );

    expect(
      buildSandboxEgressNetworkPolicy({
        credentialToken: token,
        traceConfig: { domains: ["sentry.io"] },
        traceHeaders: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
      }),
    ).toMatchObject({
      allow: {
        "sentry.io": [
          {
            transform: [
              {
                headers: {
                  "sentry-trace": "trace-span-1",
                  baggage: "sentry-release=abc",
                  traceparent: "00-trace-span-01",
                },
              },
            ],
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
          },
        ],
        "us.sentry.io": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${token}`,
          },
        ],
      },
    });
  });

  it("adds trace propagation transforms only for configured domains", () => {
    getProvidersMock.mockReturnValue([sentryPlugin(), githubPlugin()]);

    expect(
      buildSandboxEgressNetworkPolicy({
        traceConfig: { domains: ["*.sentry.io"] },
        traceHeaders: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
      }),
    ).toMatchObject({
      allow: {
        "*.sentry.io": [
          {
            transform: [
              {
                headers: {
                  "sentry-trace": "trace-span-1",
                  baggage: "sentry-release=abc",
                  traceparent: "00-trace-span-01",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("adds trace-only domains without provider forwarding", () => {
    getProvidersMock.mockReturnValue([sentryPlugin()]);

    expect(
      buildSandboxEgressNetworkPolicy({
        traceConfig: { domains: ["*.sentry.io"] },
        traceHeaders: {
          "sentry-trace": "trace-span-1",
        },
      }),
    ).toEqual({
      allow: {
        "*": [],
        "*.sentry.io": [
          {
            transform: [
              {
                headers: {
                  "sentry-trace": "trace-span-1",
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("fails sandbox egress policy setup without a public callback URL", () => {
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;

    expect(() =>
      buildSandboxEgressNetworkPolicy({ credentialToken: "signed-token" }),
    ).toThrow("Cannot determine base URL for sandbox credential egress");
  });

  it("does not reuse Slack signing secret for sandbox egress tokens", () => {
    delete process.env.JUNIOR_SECRET;
    process.env.SLACK_SIGNING_SECRET = "test-slack-signing-secret";

    expect(() =>
      createSandboxEgressCredentialToken({
        credentials: { actor: { type: "user", userId: ACTOR_ID } },
        egressId: EGRESS_ID,
        ttlMs: 60_000,
      }),
    ).toThrow("Cannot determine sandbox egress secret (set JUNIOR_SECRET)");
  });

  it("resolves command env for registered sandbox providers", async () => {
    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("resolves command env for every registered sandbox provider", async () => {
    getProvidersMock.mockReturnValue([githubPlugin(), sentryPlugin()]);

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      GITHUB_READ_ONLY: "1",
      GITHUB_TOKEN: "ghp_host_managed_credential",
      SENTRY_READ_ONLY: "1",
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });
  });

  it("does not invent token env placeholders for domain-only providers", async () => {
    getProvidersMock.mockReturnValue([headerOnlyPlugin()]);

    await expect(resolveSandboxCommandEnvironment()).resolves.toEqual({
      HEADER_ONLY_READ_ONLY: "1",
    });
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
    setSandboxEgressUserActor();
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
      expect(new Headers(init?.headers).get("sentry-trace")).toBe(
        "trace-span-1",
      );
      expect(new Headers(init?.headers).get("baggage")).toBe(
        "sentry-release=abc",
      );
      expect(new Headers(init?.headers).get("traceparent")).toBe(
        "00-trace-span-01",
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
        "sentry-trace": "trace-span-1",
        baggage: "sentry-release=abc",
        traceparent: "00-trace-span-01",
        "x-api-key": "sandbox-key",
        "x-forwarded-for": "127.0.0.1",
      },
    });

    const response = await proxy(request, fetchMock as typeof fetch, {
      domains: ["sentry.io"],
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      context: { actor: { type: "user", userId: ACTOR_ID } },
      provider: "sentry",
      reason: "sandbox-egress:sentry:read",
    });

    const repeated = await proxy(
      new Request(request.url, {
        method: "GET",
        headers: request.headers,
      }),
      fetchMock as typeof fetch,
      { domains: ["sentry.io"] },
    );

    expect(repeated.status).toBe(200);
    await expect(repeated.text()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("strips Sentry trace propagation before forwarding non-Sentry requests", async () => {
    getProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock.mockResolvedValue({
      id: "lease-1",
      provider: "github",
      env: {},
      headerTransforms: [
        {
          domain: "api.github.com",
          headers: {
            Authorization: "Bearer github-token",
            "sentry-trace": "lease-trace-span",
          },
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer github-token");
      expect(headers.get("sentry-trace")).toBeNull();
      expect(headers.get("baggage")).toBeNull();
      expect(headers.get("traceparent")).toBeNull();
      return new Response("ok", { status: 200 });
    });

    const response = await proxy(
      egressRequest({
        host: "api.github.com",
        path: "/repos/getsentry/junior",
        headers: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unbound delegated credential subjects under signed egress contexts", async () => {
    activeCredentialToken = createSandboxEgressCredentialToken({
      credentials: {
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: ACTOR_ID,
          allowedWhen: "private-direct-conversation",
        } as any,
      },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });

    const response = await proxy(
      egressRequest({
        host: "sentry.io",
        path: "/api/0/issues/1",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox egress credential context is not authorized",
    });
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("preserves delegated credential subjects under system actor contexts", async () => {
    setSandboxEgressSystemActor({
      subject: {
        type: "user",
        userId: ACTOR_ID,
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: "T123",
          channelId: "D123",
          signature: "v1=test",
        },
      },
    });
    mockSentryLease();

    const response = await proxy(
      egressRequest({
        host: "sentry.io",
        path: "/api/0/issues/1",
      }),
    );

    expect(response.status).toBe(200);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      context: {
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: ACTOR_ID,
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: "v1=test",
          },
        },
      },
      provider: "sentry",
      reason: "sandbox-egress:sentry:read",
    });
  });

  it("prefers Vercel forwarded path over the normalized proxy URL path", async () => {
    setSandboxEgressUserActor();
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

  it("rejects sandbox egress requests without a forwarded path", async () => {
    setSandboxEgressUserActor();

    const fetchMock = vi.fn();
    const response = await proxy(
      egressRequest({
        forwardedPath: null,
        proxyPath: `${SANDBOX_EGRESS_PROXY_PATH}/${activeCredentialToken}`,
      }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing forwarded path",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
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
    setSandboxEgressUserActor();
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

  it("scopes cached credential leases to the actor", async () => {
    setSandboxEgressUserActor();
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

    setSandboxEgressUserActor("U456");
    const secondResponse = await proxy(
      egressRequest({
        path: "/api/0/issues/2",
        headers: { "vercel-sandbox-oidc-token": "signed-token-2" },
      }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe("Bearer token-u456");

    expect(issueProviderCredentialLeaseMock).toHaveBeenNthCalledWith(1, {
      context: { actor: { type: "user", userId: ACTOR_ID } },
      provider: "sentry",
      reason: "sandbox-egress:sentry:read",
    });
    expect(issueProviderCredentialLeaseMock).toHaveBeenNthCalledWith(2, {
      context: { actor: { type: "user", userId: "U456" } },
      provider: "sentry",
      reason: "sandbox-egress:sentry:read",
    });
  });

  it("does not reuse cached credential leases across renewed credential contexts", async () => {
    setSandboxEgressUserActor();
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

    setSandboxEgressUserActor();
    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe(
      "Bearer token-second-session",
    );

    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("passes through upstream 403 responses without overriding the body", async () => {
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock.mockResolvedValue({
      id: "lease-1",
      provider: "sentry",
      env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
      headerTransforms: [
        { domain: "sentry.io", headers: { Authorization: "Bearer token" } },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response("Permission denied for this organization", {
          status: 403,
        }),
    );

    const response = await proxy(
      egressRequest({ path: "/api/0/issues/1" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toBe("Permission denied for this organization");
    expect(body).not.toContain("junior-auth-required");
    await expect(
      consumeSandboxEgressPermissionDeniedSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "sentry",
      grant: {
        name: "default",
        access: "read",
      },
      message:
        "sentry returned HTTP 403 after Junior injected the default grant. Junior forwarded the request; this is not a local runtime block.",
      source: "upstream",
      status: 403,
      upstreamHost: "sentry.io",
      upstreamPath: "/api/0/issues/1",
    });

    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    expect(secondResponse.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("lets headless resource-event runs use scoped GitHub installation grants", async () => {
    setSandboxEgressSystemActor({ name: "resource-event" });
    getProvidersMock.mockReturnValue([githubPlugin()]);
    const issueCredential = vi.fn((_ctx: IssueCredentialHookContext) => {
      return {
        type: "lease" as const,
        lease: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: { Authorization: "Bearer github-installation-token" },
            },
            {
              domain: "github.com",
              headers: { Authorization: "Bearer github-installation-token" },
            },
          ],
        },
      };
    });
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: githubPlugin().manifest,
        hooks: {
          grantForEgress(ctx) {
            if (ctx.request.url.includes("/issues/780")) {
              return {
                name: "installation-write",
                access: "write",
                leaseScope: "repository:getsentry/junior",
                reason: "github.installation-write",
              };
            }
            return {
              name: "installation-write",
              access: "write",
              leaseScope: "repository:getsentry/sentry-mcp",
              reason: "github.installation-write",
            };
          },
          issueCredential,
        },
      }),
    ]);
    try {
      const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer github-installation-token",
        );
        if (
          String(url) ===
          "https://api.github.com/repos/getsentry/junior/issues/780"
        ) {
          return new Response("ok");
        }
        expect(String(url)).toBe(
          "https://github.com/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
        );
        return new Response("write denied", {
          status: 403,
          headers: {
            "x-accepted-github-permissions": "contents=write",
            "x-github-sso":
              "required; url=https://github.com/orgs/getsentry/sso",
          },
        });
      });

      const issueResponse = await proxy(
        egressRequest({
          host: "api.github.com",
          method: "PATCH",
          path: "/repos/getsentry/junior/issues/780",
          body: '{"state":"closed"}',
        }),
        fetchMock as typeof fetch,
      );
      expect(issueResponse.status).toBe(200);

      const response = await proxy(
        egressRequest({
          host: "github.com",
          path: "/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
        }),
        fetchMock as typeof fetch,
      );

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe("write denied");
      expect(issueCredential).toHaveBeenCalledTimes(2);
      expect(issueCredential).toHaveBeenLastCalledWith(
        expect.objectContaining({
          actor: { platform: "system", name: "resource-event" },
          grant: expect.objectContaining({
            name: "installation-write",
            leaseScope: "repository:getsentry/sentry-mcp",
          }),
          tokens: {},
        }),
      );
      expect(issueCredential.mock.calls[1]?.[0]).not.toHaveProperty(
        "credentialSubject",
      );
      await expect(
        consumeSandboxEgressPermissionDeniedSignal(EGRESS_ID),
      ).resolves.toMatchObject({
        provider: "github",
        grant: {
          name: "installation-write",
          access: "write",
          leaseScope: "repository:getsentry/sentry-mcp",
          reason: "github.installation-write",
        },
        message:
          "github returned HTTP 403 after Junior injected the installation-write grant. Junior forwarded the request; this is not a local runtime block.",
        source: "upstream",
        status: 403,
        upstreamHost: "github.com",
        upstreamPath:
          "/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
        acceptedPermissions: "contents=write",
        sso: "required; url=https://github.com/orgs/getsentry/sso",
      });
    } finally {
      setPlugins(previous);
    }
  });

  it("applies provider header transforms to matching upstream hosts", async () => {
    setSandboxEgressUserActor();
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
    setSandboxEgressUserActor();
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
    setSandboxEgressUserActor();
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
    setSandboxEgressUserActor();
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

  it("requires a signed credential context", async () => {
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("rejects credential context tokens from a different sandbox session", async () => {
    activeCredentialToken = createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: ACTOR_ID } },
      egressId: "different-egress-session",
      ttlMs: 60_000,
    });
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("rejects tampered credential tokens", async () => {
    setSandboxEgressUserActor();
    activeCredentialToken = `${activeCredentialToken ?? ""}tampered`;
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });
});
