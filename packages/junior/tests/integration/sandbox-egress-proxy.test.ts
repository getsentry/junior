import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import {
  createLocalSource,
  defineJuniorPlugin,
  EgressAuthRequired,
  type PluginHooks,
} from "@sentry/junior-plugin-api";
import { Type } from "@sinclair/typebox";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "@/chat/tools/definition";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { githubPlugin } from "@sentry/junior-github";
import { mswServer } from "../msw/server";

const ORIGINAL_ENV = { ...process.env };
const FIXTURE_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/sandbox-egress",
);
const BASE_URL = "https://junior.example.com";
const EGRESS_ID = "sbx_integration_session";
const REQUESTER_ID = "U123";
const PROVIDER_HOST = "sandbox-egress.example.test";
const MANAGED_PROVIDER_HOST = "managed-egress.example.test";
const MANAGED_PROVIDER_SUBDOMAIN = "api.managed-egress.example.test";
const OAUTH_BROKER_PROVIDER_HOST = "oauth-broker.example.test";
const GITHUB_API_HOST = "api.github.com";

type EgressPolicyModule = typeof import("@/chat/sandbox/egress/policy");
type EgressProxyModule = typeof import("@/chat/sandbox/egress/proxy");
type EgressSessionModule = typeof import("@/chat/sandbox/egress/session");
type StateAdapterModule = typeof import("@/chat/state/adapter");

interface LoadedModules {
  policy: EgressPolicyModule;
  proxy: EgressProxyModule;
  session: EgressSessionModule;
  state: StateAdapterModule;
}

async function loadModules(): Promise<LoadedModules> {
  vi.resetModules();
  const [policy, proxy, session, state] = await Promise.all([
    import("@/chat/sandbox/egress/policy"),
    import("@/chat/sandbox/egress/proxy"),
    import("@/chat/sandbox/egress/session"),
    import("@/chat/state/adapter"),
  ]);
  await state.disconnectStateAdapter();
  await state.getStateAdapter().connect();
  return { policy, proxy, session, state };
}

function forwardUrlFor(policy: unknown, host: string): string {
  const allow = (
    policy as { allow?: Record<string, Array<{ forwardURL?: string }>> }
  ).allow;
  const forwardURL = allow?.[host]?.[0]?.forwardURL;
  if (!forwardURL) {
    throw new Error(`Missing forwardURL for ${host}`);
  }
  return forwardURL;
}

function traceHeadersFor(
  policy: unknown,
  host: string,
): Record<string, string> | undefined {
  const allow = (
    policy as {
      allow?: Record<
        string,
        Array<{ transform?: Array<{ headers?: Record<string, string> }> }>
      >;
    }
  ).allow;
  return allow?.[host]?.[0]?.transform?.[0]?.headers;
}

function proxiedRequest(input: {
  body?: BodyInit;
  forwardURL: string;
  headers?: Record<string, string>;
  method?: string;
  upstreamHost?: string;
  upstreamPath?: string;
}): Request {
  const url = new URL(input.forwardURL);
  const upstreamPath = input.upstreamPath ?? "/v1/repos?query=first";
  url.pathname = `${url.pathname}${upstreamPath.split("?")[0]}`;
  url.search = upstreamPath.includes("?")
    ? `?${upstreamPath.split("?").slice(1).join("?")}`
    : "";

  return new Request(url, {
    method: input.method ?? "GET",
    ...(input.body !== undefined ? { body: input.body } : {}),
    headers: {
      "vercel-forwarded-host": input.upstreamHost ?? PROVIDER_HOST,
      "vercel-forwarded-path": upstreamPath,
      "vercel-forwarded-scheme": "https",
      "vercel-sandbox-oidc-token": "signed-vercel-token",
      ...(input.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(input.headers ?? {}),
    },
  });
}

async function registerManagedEgressPlugin(input?: {
  egressTracePropagationDomains?: string[];
  grantForEgress?: NonNullable<PluginHooks["grantForEgress"]>;
  issueCredential?: NonNullable<PluginHooks["issueCredential"]>;
  onEgressResponse?: NonNullable<PluginHooks["onEgressResponse"]>;
  tools?: NonNullable<PluginHooks["tools"]>;
}) {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "managed-egress",
          displayName: "Managed Egress",
          description: "Managed egress integration fixture",
          capabilities: ["api"],
          domains: [MANAGED_PROVIDER_HOST, MANAGED_PROVIDER_SUBDOMAIN],
        },
        hooks: {
          grantForEgress:
            input?.grantForEgress ??
            ((ctx) =>
              ctx.request.method === "POST"
                ? {
                    name: "user-write",
                    access: "write",
                    reason: "managed.write",
                  }
                : {
                    name: "installation-read",
                    access: "read",
                    reason: "managed.read",
                  }),
          issueCredential:
            input?.issueCredential ??
            ((ctx) => ({
              type: "lease",
              lease: {
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                headerTransforms: [
                  MANAGED_PROVIDER_HOST,
                  MANAGED_PROVIDER_SUBDOMAIN,
                ].map((domain) => ({
                  domain,
                  headers: {
                    Authorization: `Bearer ${ctx.grant.name}`,
                  },
                })),
              },
            })),
          ...(input?.onEgressResponse
            ? { onEgressResponse: input.onEgressResponse }
            : {}),
          ...(input?.tools ? { tools: input.tools } : {}),
        },
      }),
    ]),
    sandbox: {
      egressTracePropagationDomains: input?.egressTracePropagationDomains,
    },
    waitUntil(task) {
      if (typeof task === "function") {
        void task();
      }
    },
  });
}

async function registerOAuthBrokerPlugin() {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "oauth-broker",
          displayName: "Oauth Broker",
          description: "OAuth broker integration fixture",
          capabilities: ["api"],
          credentials: {
            type: "oauth-bearer",
            domains: [OAUTH_BROKER_PROVIDER_HOST],
            authTokenEnv: "OAUTH_BROKER_ACCESS_TOKEN",
            authTokenPlaceholder: "host_managed_credential",
          },
          oauth: {
            clientIdEnv: "OAUTH_BROKER_CLIENT_ID",
            clientSecretEnv: "OAUTH_BROKER_CLIENT_SECRET",
            authorizeEndpoint: "https://oauth-broker.example.test/authorize",
            tokenEndpoint: "https://oauth-broker.example.test/token",
            scope: "broker.read",
          },
        },
      }),
    ]),
    waitUntil(task) {
      if (typeof task === "function") {
        void task();
      }
    },
  });
}

async function registerGitHubPlugin(
  options?: Parameters<typeof githubPlugin>[0],
) {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  const plugin = githubPlugin(options);
  await createApp({
    plugins: defineJuniorPlugins([
      {
        ...plugin,
        packageName: undefined,
      },
    ]),
    waitUntil(task) {
      if (typeof task === "function") {
        void task();
      }
    },
  });
}

function configureGitHubAppEnv() {
  process.env.GITHUB_APP_ID = "123";
  process.env.GITHUB_INSTALLATION_ID = "456";
  process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

function mockGitHubInstallationToken() {
  const requests: unknown[] = [];
  mswServer.use(
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      async ({ request }) => {
        requests.push(await request.json());
        return HttpResponse.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      },
    ),
  );
  return requests;
}

describe("sandbox egress proxy integration", () => {
  let modules: LoadedModules;
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: BASE_URL,
      JUNIOR_SECRET: "integration-secret",
      JUNIOR_STATE_ADAPTER: "memory",
      SANDBOX_EGRESS_TEST_TOKEN: "integration-egress-token",
    };
    pluginApp = await createPluginAppFixture([FIXTURE_PLUGIN_ROOT]);
    modules = await loadModules();
  });

  afterEach(async () => {
    await modules?.state.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("injects provider credentials through real plugin and broker wiring without command session state", async () => {
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, PROVIDER_HOST);

    expect(forwardURL).toBe(
      `${BASE_URL}/api/internal/sandbox-egress/${credentialToken}`,
    );

    const upstreamFetch = vi.fn(
      async (url: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(String(url)).toBe(
          "https://sandbox-egress.example.test/v1/repos?query=first",
        );
        expect(headers.get("authorization")).toBe(
          "Bearer integration-egress-token",
        );
        expect(headers.get("vercel-sandbox-oidc-token")).toBeNull();
        return new Response("ok", { status: 200 });
      },
    );

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({ forwardURL }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("returns auth-required via canonical egress credential error when broker has no user token", async () => {
    // Broker-backed provider (sandbox-egress-test fixture) with no stored user OAuth token.
    // Since the fixture has no `oauth` section, the broker throws CredentialUnavailableError
    // for the missing-env-token case. This should be normalized to an egress credential error
    // before reaching the proxy, and the proxy should return the canonical auth-required 401.
    delete process.env.SANDBOX_EGRESS_TEST_TOKEN; // remove env token so broker has no credential

    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, PROVIDER_HOST);

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({ forwardURL }),
      { verifyOidc: async () => ({ sandbox_id: EGRESS_ID }) },
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("junior-auth-required");
    expect(body).toContain("provider=sandbox-egress-test");

    // Auth signal should be recorded in state
    const signal =
      await modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID);
    expect(signal).toMatchObject({
      provider: "sandbox-egress-test",
      grant: expect.objectContaining({ access: "read" }),
    });
  });

  it("records OAuth authorization metadata for broker credential gaps", async () => {
    delete process.env.OAUTH_BROKER_ACCESS_TOKEN;
    await registerOAuthBrokerPlugin();

    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, OAUTH_BROKER_PROVIDER_HOST);

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: OAUTH_BROKER_PROVIDER_HOST,
      }),
      { verifyOidc: async () => ({ sandbox_id: EGRESS_ID }) },
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=oauth-broker grant=default access=read",
    );
    await expect(
      modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "oauth-broker",
      grant: {
        name: "default",
        access: "read",
      },
      authorization: {
        type: "oauth",
        provider: "oauth-broker",
        scope: "broker.read",
      },
    });
  });

  it("propagates configured trace headers through real plugin egress wiring", async () => {
    await registerManagedEgressPlugin({
      egressTracePropagationDomains: ["*.managed-egress.example.test"],
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
      traceConfig: { domains: ["*.managed-egress.example.test"] },
      traceHeaders: {
        "sentry-trace": "trace-span-1",
        baggage: "sentry-release=abc",
        traceparent: "00-trace-span-01",
      },
    });
    expect(traceHeadersFor(networkPolicy, MANAGED_PROVIDER_SUBDOMAIN)).toEqual({
      "sentry-trace": "trace-span-1",
      baggage: "sentry-release=abc",
      traceparent: "00-trace-span-01",
    });
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_SUBDOMAIN);
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer installation-read");
        expect(headers.get("sentry-trace")).toBe("trace-span-1");
        expect(headers.get("baggage")).toBe("sentry-release=abc");
        expect(headers.get("traceparent")).toBe("00-trace-span-01");
        return new Response("ok", { status: 200 });
      },
    );

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        headers: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
        upstreamHost: MANAGED_PROVIDER_SUBDOMAIN,
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        tracePropagation: { domains: ["*.managed-egress.example.test"] },
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("strips trace headers from unconfigured real plugin egress wiring", async () => {
    await registerManagedEgressPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
      traceHeaders: {
        "sentry-trace": "trace-span-1",
        baggage: "sentry-release=abc",
        traceparent: "00-trace-span-01",
      },
    });
    expect(
      traceHeadersFor(networkPolicy, MANAGED_PROVIDER_HOST),
    ).toBeUndefined();
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_HOST);
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer installation-read");
        expect(headers.get("sentry-trace")).toBeNull();
        expect(headers.get("baggage")).toBeNull();
        expect(headers.get("traceparent")).toBeNull();
        return new Response("ok", { status: 200 });
      },
    );

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        headers: {
          "sentry-trace": "trace-span-1",
          baggage: "sentry-release=abc",
          traceparent: "00-trace-span-01",
        },
        upstreamHost: MANAGED_PROVIDER_HOST,
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("reuses broker-managed credentials across read and write egress", async () => {
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, PROVIDER_HOST);
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) =>
        new Response(new Headers(init?.headers).get("authorization")),
    );

    const readResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({ forwardURL }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.text()).resolves.toBe(
      "Bearer integration-egress-token",
    );

    const writeResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        method: "POST",
        upstreamPath: "/v1/repos",
        body: JSON.stringify({ name: "repo" }),
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.text()).resolves.toBe(
      "Bearer integration-egress-token",
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("intercepts credential-injected provider traffic before live forwarding", async () => {
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, PROVIDER_HOST);
    const upstreamFetch = vi.fn();
    const interceptHttp = vi.fn(async (_input: { request: Request }) => {
      return Response.json({ ok: true });
    });

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamPath: "/v1/repos?query=first",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        interceptHttp,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(interceptHttp).toHaveBeenCalledTimes(1);
    expect(
      interceptHttp.mock.calls[0]?.[0].request.headers.get("authorization"),
    ).toBe("Bearer integration-egress-token");
  });

  it("uses plugin egress hooks to issue request-scoped credentials", async () => {
    await registerManagedEgressPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_HOST);
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) =>
        new Response(new Headers(init?.headers).get("authorization")),
    );

    const readResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.text()).resolves.toBe("Bearer installation-read");

    const writeResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        method: "POST",
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
        body: JSON.stringify({ title: "test" }),
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.text()).resolves.toBe("Bearer user-write");
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });

  it("lets a host-registered plugin tool fetch provider data through ctx.egress", async () => {
    const grantForEgress = vi.fn((ctx) =>
      ctx.request.operation === "managed.issues.read"
        ? {
            name: "installation-read",
            access: "read" as const,
            reason: "managed.issues.read",
          }
        : {
            name: "unknown-operation",
            access: "read" as const,
            reason: "managed.unknown",
          },
    );
    const issueCredential = vi.fn((ctx) => ({
      type: "lease" as const,
      lease: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        headerTransforms: [
          {
            domain: MANAGED_PROVIDER_HOST,
            headers: {
              Authorization: `Bearer ${ctx.grant.name}`,
            },
          },
        ],
      },
    }));
    await registerManagedEgressPlugin({
      grantForEgress,
      issueCredential,
      tools(ctx) {
        return {
          managedEgressRead: tool({
            description: "Read managed provider data through host egress",
            inputSchema: Type.Object({}),
            async execute() {
              const response = await ctx.egress.fetch({
                provider: "managed-egress",
                operation: "managed.issues.read",
                request: new Request(
                  `https://${MANAGED_PROVIDER_HOST}/v1/issues`,
                ),
              });
              return {
                ok: response.ok,
                status: response.status,
                body: await response.text(),
              };
            },
          }),
        };
      },
    });
    const upstreamFetch = vi.fn(
      async (url: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(String(url)).toBe(`https://${MANAGED_PROVIDER_HOST}/v1/issues`);
        expect(headers.get("authorization")).toBe("Bearer installation-read");
        return new Response("provider ok");
      },
    );
    const [
      { createPluginEgress },
      { SkillSandbox },
      { createAgentTools },
      toolsModule,
    ] = await Promise.all([
      import("@/chat/egress/plugin"),
      import("@/chat/sandbox/skill-sandbox"),
      import("@/chat/tools/agent-tools"),
      import("@/chat/tools"),
    ]);
    const conversationId = "local:test:plugin-egress-tool";
    const tools = toolsModule.createTools(
      [],
      {},
      {
        destination: {
          platform: "local",
          conversationId,
        },
        egress: createPluginEgress({
          credentialContext: { actor: { type: "user", userId: REQUESTER_ID } },
          fetch: upstreamFetch as typeof fetch,
          pluginAuth: {
            handleAuthRequired: vi.fn(),
          },
        }),
        sandbox: {} as Parameters<typeof toolsModule.createTools>[2]["sandbox"],
        source: createLocalSource(conversationId),
      },
    );

    const agentTools = createAgentTools(tools, new SkillSandbox([], []), {});
    const managedEgressRead = agentTools.find(
      (candidate) => candidate.name === "managedEgressRead",
    );
    if (!managedEgressRead) {
      throw new Error("managedEgressRead tool was not registered");
    }

    const result = await managedEgressRead.execute(
      "tool-call-managed-egress-read",
      {},
    );

    expect(result).toMatchObject({
      details: {
        ok: true,
        status: 200,
        body: "provider ok",
      },
    });
    expect(grantForEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          method: "GET",
          operation: "managed.issues.read",
          url: `https://${MANAGED_PROVIDER_HOST}/v1/issues`,
        },
      }),
    );
    expect(issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "user", userId: REQUESTER_ID },
        grant: {
          name: "installation-read",
          access: "read",
          reason: "managed.issues.read",
        },
      }),
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("lets plugin response hooks interrupt egress for auth-required recovery", async () => {
    await registerManagedEgressPlugin({
      onEgressResponse() {
        throw new EgressAuthRequired("Managed provider needs reauthorization.");
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_HOST);
    const upstreamFetch = vi.fn(async () => new Response("provider response"));

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=managed-egress grant=installation-read access=read",
    );
    await expect(
      modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "managed-egress",
      grant: {
        name: "installation-read",
        access: "read",
      },
      message: "Managed provider needs reauthorization.",
    });
  });

  it("keeps response hook header mutations isolated from upstream pass-through", async () => {
    await registerManagedEgressPlugin({
      onEgressResponse(ctx) {
        ctx.response.headers.delete("x-provider-result");
        ctx.response.headers.set("x-plugin-only", "changed");
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_HOST);

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
      }),
      {
        fetch: vi.fn(
          async () =>
            new Response("provider response", {
              headers: {
                "x-provider-result": "kept",
              },
            }),
        ) as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-provider-result")).toBe("kept");
    expect(response.headers.get("x-plugin-only")).toBeNull();
    await expect(response.text()).resolves.toBe("provider response");
  });

  it("uses GitHub App credentials for GraphQL issue list queries", async () => {
    configureGitHubAppEnv();
    mockGitHubInstallationToken();
    await registerGitHubPlugin({
      appPermissions: {
        contents: "read",
        issues: "write",
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) =>
        new Response(new Headers(init?.headers).get("authorization")),
    );

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        body: JSON.stringify({
          query:
            "fragment issue on Issue { number title state url } query IssueList($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(first: 1) { nodes { ...issue } } } }",
          variables: { owner: "getsentry", name: "junior-prod" },
        }),
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/graphql",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("Bearer installation-token");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it("records GitHub GraphQL repository access errors without rewriting the response", async () => {
    configureGitHubAppEnv();
    mockGitHubInstallationToken();
    await registerGitHubPlugin({
      appPermissions: {
        contents: "read",
        issues: "write",
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const graphqlBody = {
      data: {
        repository: null,
      },
      errors: [
        {
          type: "NOT_FOUND",
          path: ["repository"],
          message:
            "Could not resolve to a Repository with the name 'getsentry/junior-prod'.",
        },
      ],
    };
    const upstreamFetch = vi.fn(
      async (_url: URL | string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer installation-token",
        );
        return HttpResponse.json(graphqlBody);
      },
    );

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        body: JSON.stringify({
          query:
            "query IssueList($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(first: 1) { nodes { number } } } }",
          variables: { owner: "getsentry", name: "junior-prod" },
        }),
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/graphql",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(graphqlBody);
    await expect(
      modules.session.consumeSandboxEgressPermissionDeniedSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "github",
      grant: {
        name: "installation-read",
        access: "read",
      },
      message:
        "GitHub GraphQL could not access the repository: Could not resolve to a Repository with the name 'getsentry/junior-prod'.",
      source: "upstream",
      status: 200,
      upstreamHost: GITHUB_API_HOST,
      upstreamPath: "/graphql",
    });
  });

  it("passes through successful GitHub GraphQL responses without permission signals", async () => {
    configureGitHubAppEnv();
    mockGitHubInstallationToken();
    await registerGitHubPlugin({
      appPermissions: {
        contents: "read",
        issues: "write",
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const graphqlBody = {
      data: {
        repository: {
          issues: {
            nodes: [],
          },
        },
      },
    };

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        body: JSON.stringify({
          query:
            "query IssueList($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { issues(first: 1) { nodes { number } } } }",
          variables: { owner: "getsentry", name: "junior-prod" },
        }),
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/graphql",
      }),
      {
        fetch: vi.fn(async () =>
          HttpResponse.json(graphqlBody),
        ) as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(graphqlBody);
    await expect(
      modules.session.consumeSandboxEgressPermissionDeniedSignal(EGRESS_ID),
    ).resolves.toBeUndefined();
  });

  it("denies raw GitHub REST issue creation before credential injection", async () => {
    await registerGitHubPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const upstreamFetch = vi.fn();

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/repos/getsentry/junior/issues",
        body: JSON.stringify({ title: "test" }),
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "GitHub issue creation must use the github.createIssue tool so Junior can own idempotency and the conversation footer.",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(
      modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toBeUndefined();
  });

  it("denies raw GitHub GraphQL issue creation before credential injection", async () => {
    await registerGitHubPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const upstreamFetch = vi.fn();

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        body: JSON.stringify({
          query:
            "mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }",
          variables: { input: { repositoryId: "repo", title: "test" } },
        }),
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/graphql",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "GitHub issue creation must use the github.createIssue tool so Junior can own idempotency and the conversation footer.",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("denies oversized raw GitHub GraphQL before credential injection", async () => {
    await registerGitHubPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const upstreamFetch = vi.fn();

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        body: JSON.stringify({
          query:
            "mutation CreateIssue($input: CreateIssueInput!) { createIssue(input: $input) { issue { number } } }",
          variables: {
            input: { repositoryId: "repo", title: "test" },
            filler: "x".repeat(70 * 1024),
          },
        }),
        forwardURL,
        method: "POST",
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/graphql",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "GitHub GraphQL request body is too large for Junior to inspect before issuing credentials.",
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("records plugin write auth needs over earlier read failures", async () => {
    await registerManagedEgressPlugin({
      issueCredential(ctx) {
        return {
          type: "needed",
          message: `${ctx.grant.name} needs auth`,
        };
      },
    });
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, MANAGED_PROVIDER_HOST);

    const readResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
      }),
      {
        fetch: vi.fn() as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );
    expect(readResponse.status).toBe(401);

    const writeResponse = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        method: "POST",
        upstreamHost: MANAGED_PROVIDER_HOST,
        upstreamPath: "/v1/issues",
        body: JSON.stringify({ title: "test" }),
      }),
      {
        fetch: vi.fn() as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );
    expect(writeResponse.status).toBe(401);
    await expect(writeResponse.text()).resolves.toContain(
      "junior-auth-required provider=managed-egress grant=user-write access=write",
    );

    await expect(
      modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "managed-egress",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("returns a controlled egress auth response when GitHub App setup is unavailable", async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_INSTALLATION_ID;
    await registerGitHubPlugin();
    const credentialToken = modules.session.createSandboxEgressCredentialToken({
      credentials: { actor: { type: "user", userId: REQUESTER_ID } },
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      credentialToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, GITHUB_API_HOST);
    const upstreamFetch = vi.fn();

    const response = await modules.proxy.proxySandboxEgressRequest(
      proxiedRequest({
        forwardURL,
        upstreamHost: GITHUB_API_HOST,
        upstreamPath: "/repos/getsentry/junior/issues",
      }),
      {
        fetch: upstreamFetch as typeof fetch,
        verifyOidc: async () => ({ sandbox_id: EGRESS_ID }),
      },
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=github grant=installation-read access=read 401 unauthorized\nMissing GITHUB_APP_ID",
    );
    expect(upstreamFetch).not.toHaveBeenCalled();
    await expect(
      modules.session.consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "github",
      kind: "unavailable",
      grant: {
        name: "installation-read",
        access: "read",
      },
      message: "Missing GITHUB_APP_ID",
    });
  });
});
