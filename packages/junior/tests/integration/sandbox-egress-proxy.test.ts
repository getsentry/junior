import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  forwardURL: string;
  headers?: Record<string, string>;
  upstreamPath?: string;
}): Request {
  const url = new URL(input.forwardURL);
  const upstreamPath = input.upstreamPath ?? "/v1/repos?query=first";
  url.pathname = `${url.pathname}${upstreamPath.split("?")[0]}`;
  url.search = upstreamPath.includes("?")
    ? `?${upstreamPath.split("?").slice(1).join("?")}`
    : "";

  return new Request(url, {
    headers: {
      "vercel-forwarded-host": PROVIDER_HOST,
      "vercel-forwarded-path": upstreamPath,
      "vercel-forwarded-scheme": "https",
      "vercel-sandbox-oidc-token": "signed-vercel-token",
      ...(input.headers ?? {}),
    },
  });
}

describe("sandbox egress proxy integration", () => {
  let modules: LoadedModules;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      EVAL_ENABLE_TEST_CREDENTIALS: "1",
      EVAL_TEST_CREDENTIAL_TOKEN: "integration-egress-token",
      JUNIOR_BASE_URL: BASE_URL,
      JUNIOR_EXTRA_PLUGIN_ROOTS: JSON.stringify([FIXTURE_PLUGIN_ROOT]),
      JUNIOR_SANDBOX_EGRESS_SECRET: "integration-egress-secret",
      JUNIOR_STATE_ADAPTER: "memory",
    };
    modules = await loadModules();
  });

  afterEach(async () => {
    await modules.state.disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("injects provider credentials through real plugin and broker wiring without command session state", async () => {
    const requesterToken = modules.session.createSandboxEgressRequesterToken({
      requesterId: REQUESTER_ID,
      egressId: EGRESS_ID,
      ttlMs: 60_000,
    });
    const networkPolicy = modules.policy.buildSandboxEgressNetworkPolicy({
      requesterToken,
    });
    const forwardURL = forwardUrlFor(networkPolicy, PROVIDER_HOST);

    expect(forwardURL).toBe(
      `${BASE_URL}/api/internal/sandbox-egress/${requesterToken}`,
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
});
