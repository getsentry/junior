import path from "node:path";
import {
  defineJuniorPlugin,
  type AgentPluginHooks,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import { githubPlugin } from "../../../junior-github/index.js";

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
const GITHUB_API_HOST = "api.github.com";

type EgressPolicyModule = typeof import("@/chat/sandbox/egress-policy");
type EgressProxyModule = typeof import("@/chat/sandbox/egress-proxy");
type EgressSessionModule = typeof import("@/chat/sandbox/egress-session");
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
    import("@/chat/sandbox/egress-policy"),
    import("@/chat/sandbox/egress-proxy"),
    import("@/chat/sandbox/egress-session"),
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
  issueCredential?: NonNullable<AgentPluginHooks["issueCredential"]>;
}) {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "managed-egress",
          description: "Managed egress integration fixture",
          capabilities: ["api"],
          domains: [MANAGED_PROVIDER_HOST],
        },
        hooks: {
          grantForEgress(ctx) {
            return ctx.request.method === "POST"
              ? {
                  name: "user-write",
                  access: "write",
                  reason: "managed.write",
                }
              : {
                  name: "installation-read",
                  access: "read",
                  reason: "managed.read",
                };
          },
          issueCredential:
            input?.issueCredential ??
            ((ctx) => ({
              type: "lease",
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
            })),
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

async function registerGitHubPlugin() {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  const plugin = githubPlugin();
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
      grant: {
        name: "installation-read",
        access: "read",
      },
      message: "Missing GITHUB_APP_ID",
    });
  });
});
