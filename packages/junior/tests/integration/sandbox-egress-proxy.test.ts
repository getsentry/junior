import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";

const ORIGINAL_ENV = { ...process.env };
const FIXTURE_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/sandbox-egress",
);
const BASE_URL = "https://junior.example.com";
const EGRESS_ID = "sbx_integration_session";
const REQUESTER_ID = "U123";
const PROVIDER_HOST = "sandbox-egress.example.test";

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
});
