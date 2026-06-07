import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  selectPluginGrantMock,
  getPluginDefinitionMock,
  getPluginOAuthConfigMock,
  getPluginProvidersMock,
  issuePluginCredentialMock,
  issueProviderCredentialLeaseMock,
} = vi.hoisted(() => ({
  selectPluginGrantMock: vi.fn(),
  getPluginDefinitionMock: vi.fn(),
  getPluginOAuthConfigMock: vi.fn(),
  getPluginProvidersMock: vi.fn(),
  issuePluginCredentialMock: vi.fn(),
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
  getPluginDefinition: getPluginDefinitionMock,
  getPluginOAuthConfig: getPluginOAuthConfigMock,
  getPluginProviders: getPluginProvidersMock,
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({ kind: "user-token-store" }),
  issueProviderCredentialLease: issueProviderCredentialLeaseMock,
}));

vi.mock("@/chat/plugins/credential-hooks", () => ({
  selectPluginGrant: selectPluginGrantMock,
  issuePluginCredential: issuePluginCredentialMock,
}));

import { CredentialUnavailableError } from "@/chat/credentials/broker";
import { proxySandboxEgressRequest } from "@/chat/sandbox/egress-proxy";
import {
  consumeSandboxEgressAuthRequiredSignal,
  createSandboxEgressCredentialToken,
  SANDBOX_EGRESS_PROXY_PATH,
} from "@/chat/sandbox/egress-session";
import { disconnectStateAdapter } from "@/chat/state/adapter";

const EGRESS_ID = "junior-sbx";
const REQUESTER_ID = "U123";

let activeCredentialToken: string | undefined;

function sentryPlugin() {
  return {
    manifest: {
      name: "sentry",
      description: "Sentry",
      capabilities: ["sentry.api"],
      configKeys: [],
      envVars: {},
      credentials: {
        type: "oauth-bearer",
        domains: ["sentry.io"],
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
      description: "GitHub",
      capabilities: ["github.api"],
      configKeys: [],
      envVars: {},
      credentials: {
        type: "plugin-managed",
        domains: ["api.github.com", "github.com"],
        authTokenEnv: "GITHUB_TOKEN",
        authTokenPlaceholder: "ghp_host_managed_credential",
      },
    },
  };
}

function setSandboxEgressUserActor(userId = REQUESTER_ID): void {
  activeCredentialToken = createSandboxEgressCredentialToken({
    credentials: { actor: { type: "user", userId } },
    egressId: EGRESS_ID,
    ttlMs: 60_000,
  });
}

function egressRequest(
  input: {
    body?: BodyInit;
    host?: string;
    method?: string;
    path?: string;
  } = {},
): Request {
  const upstreamPath = input.path ?? "/api/0/issues/";
  const proxyPath = activeCredentialToken
    ? `${SANDBOX_EGRESS_PROXY_PATH}/${activeCredentialToken}`
    : upstreamPath;
  return new Request(`https://junior.example.com${proxyPath}`, {
    method: input.method ?? "GET",
    headers: {
      "vercel-forwarded-host": input.host ?? "sentry.io",
      "vercel-forwarded-scheme": "https",
      "vercel-sandbox-oidc-token": "signed-token",
      "vercel-forwarded-path": upstreamPath,
    },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
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

describe("sandbox egress grants", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SECRET = "test-secret";
    activeCredentialToken = undefined;
    getPluginProvidersMock.mockReturnValue([sentryPlugin()]);
    getPluginDefinitionMock.mockReset();
    getPluginDefinitionMock.mockImplementation((provider: string) =>
      [sentryPlugin(), githubPlugin()].find(
        (plugin) => plugin.manifest.name === provider,
      ),
    );
    getPluginOAuthConfigMock.mockReset();
    getPluginOAuthConfigMock.mockImplementation((provider: string) =>
      provider === "sentry" ? { provider, scope: "project:read" } : undefined,
    );
    selectPluginGrantMock.mockReset();
    selectPluginGrantMock.mockReturnValue(undefined);
    issuePluginCredentialMock.mockReset();
    issuePluginCredentialMock.mockReturnValue(undefined);
    issueProviderCredentialLeaseMock.mockReset();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_STATE_ADAPTER;
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SECRET;
    vi.restoreAllMocks();
  });

  it("issues plugin-selected grants through trusted plugin hooks", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock.mockReturnValue({
      name: "user-write",
      access: "write",
      reason: "github.issue-create",
    });
    issuePluginCredentialMock.mockResolvedValue({
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer github-user-token" },
          },
        ],
      },
    });

    const response = await proxy(
      egressRequest({
        host: "api.github.com",
        method: "POST",
        path: "/repos/getsentry/junior/issues",
        body: JSON.stringify({ title: "test" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
    expect(selectPluginGrantMock).toHaveBeenCalledWith({
      body: expect.any(Function),
      method: "POST",
      provider: "github",
      upstreamUrl: expect.objectContaining({
        hostname: "api.github.com",
        pathname: "/repos/getsentry/junior/issues",
      }),
    });
    expect(issuePluginCredentialMock).toHaveBeenCalledWith({
      actor: { type: "user", userId: REQUESTER_ID },
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.issue-create",
      },
      provider: "github",
      userTokenStore: { kind: "user-token-store" },
    });
  });

  it("rejects expired plugin-issued credential leases before forwarding", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock.mockReturnValue({
      name: "user-write",
      access: "write",
      reason: "github.issue-create",
    });
    issuePluginCredentialMock.mockResolvedValue({
      type: "lease",
      lease: {
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer expired-token" },
          },
        ],
      },
    });

    await expect(
      proxy(
        egressRequest({
          host: "api.github.com",
          method: "POST",
          path: "/repos/getsentry/junior/issues",
          body: JSON.stringify({ title: "test" }),
        }),
      ),
    ).rejects.toThrow("Credential lease for github is expired");
  });

  it("records plugin-declared authorization needs from issueCredential", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock.mockReturnValue({
      name: "user-write",
      access: "write",
      reason: "github.issue-create",
    });
    issuePluginCredentialMock.mockResolvedValue({
      type: "needed",
      message: "GitHub write access requires user authorization.",
      authorization: {
        type: "oauth",
        provider: "github",
        scope: "repo",
      },
    });

    const response = await proxy(
      egressRequest({
        host: "api.github.com",
        method: "POST",
        path: "/repos/getsentry/junior/issues",
        body: JSON.stringify({ title: "test" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
    await expect(
      consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
      authorization: {
        type: "oauth",
        provider: "github",
        scope: "repo",
      },
    });
  });

  it("uses broker credentials for non-plugin-managed providers even when hooks exist", async () => {
    setSandboxEgressUserActor();
    selectPluginGrantMock.mockReturnValue({
      name: "custom",
      access: "write",
      reason: "ignored-hook",
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

    const response = await proxy(egressRequest());

    expect(response.status).toBe(200);
    expect(selectPluginGrantMock).not.toHaveBeenCalled();
    expect(issuePluginCredentialMock).not.toHaveBeenCalled();
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      context: { actor: { type: "user", userId: REQUESTER_ID } },
      provider: "sentry",
      reason: "sandbox-egress:sentry:read",
    });
  });

  it("keeps broker write auth signals when the same default grant read failed first", async () => {
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock.mockRejectedValue(
      new CredentialUnavailableError(
        "sentry",
        "No sentry credentials available.",
      ),
    );

    const readResponse = await proxy(egressRequest());
    expect(readResponse.status).toBe(401);

    const writeResponse = await proxy(
      egressRequest({
        method: "POST",
        path: "/api/0/issues/",
      }),
    );
    expect(writeResponse.status).toBe(401);

    await expect(
      consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "sentry",
      grant: {
        name: "default",
        access: "write",
      },
    });
  });

  it("keeps write auth signals when later read auth fails in the same sandbox session", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock
      .mockReturnValueOnce({
        name: "user-write",
        access: "write",
        reason: "github.issue-create",
      })
      .mockReturnValueOnce({
        name: "installation-read",
        access: "read",
        reason: "github.api-read",
      });
    issuePluginCredentialMock.mockResolvedValue({
      type: "needed",
      message: "GitHub access requires authorization.",
    });

    const writeResponse = await proxy(
      egressRequest({
        host: "api.github.com",
        method: "POST",
        path: "/repos/getsentry/junior/issues",
      }),
    );
    expect(writeResponse.status).toBe(401);

    const readResponse = await proxy(
      egressRequest({
        host: "api.github.com",
        path: "/repos/getsentry/junior",
      }),
    );
    expect(readResponse.status).toBe(401);

    await expect(
      consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("keeps the first failed grant when later grants with the same access fail", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock
      .mockReturnValueOnce({
        name: "user-write",
        access: "write",
        reason: "github.issue-create",
      })
      .mockReturnValueOnce({
        name: "workflow-write",
        access: "write",
        reason: "github.workflow-dispatch",
      });
    issuePluginCredentialMock.mockResolvedValue({
      type: "needed",
      message: "GitHub access requires authorization.",
    });

    const issueResponse = await proxy(
      egressRequest({
        host: "api.github.com",
        method: "POST",
        path: "/repos/getsentry/junior/issues",
      }),
    );
    expect(issueResponse.status).toBe(401);

    const workflowResponse = await proxy(
      egressRequest({
        host: "api.github.com",
        method: "POST",
        path: "/repos/getsentry/junior/actions/workflows/build.yml/dispatches",
      }),
    );
    expect(workflowResponse.status).toBe(401);

    await expect(
      consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "github",
      grant: {
        name: "user-write",
        access: "write",
      },
    });
  });

  it("does not reuse plugin-managed credential leases across grant names", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressUserActor();
    selectPluginGrantMock
      .mockReturnValueOnce({
        name: "installation-read",
        access: "read",
        reason: "github.git-read",
      })
      .mockReturnValueOnce({
        name: "user-write",
        access: "write",
        reason: "github.git-write",
      });
    issuePluginCredentialMock
      .mockResolvedValueOnce({
        type: "lease",
        lease: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "github.com",
              headers: { Authorization: "Basic read-token" },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        type: "lease",
        lease: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "github.com",
              headers: { Authorization: "Basic write-token" },
            },
          ],
        },
      });

    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      return new Response(new Headers(init?.headers).get("authorization"));
    });

    const readResponse = await proxy(
      egressRequest({
        host: "github.com",
        path: "/getsentry/junior.git/info/refs?service=git-upload-pack",
      }),
      fetchMock as typeof fetch,
    );
    await expect(readResponse.text()).resolves.toBe("Basic read-token");

    const writeResponse = await proxy(
      egressRequest({
        host: "github.com",
        path: "/getsentry/junior.git/info/refs?service=git-receive-pack",
      }),
      fetchMock as typeof fetch,
    );
    await expect(writeResponse.text()).resolves.toBe("Basic write-token");

    expect(issuePluginCredentialMock).toHaveBeenCalledTimes(2);
  });

  it("returns a command-readable auth marker when upstream rejects the injected credential", async () => {
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock.mockResolvedValue({
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
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Bad credentials", { status: 401 }));

    const response = await proxy(
      egressRequest({ path: "/api/0/issues/1" }),
      fetchMock as typeof fetch,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=sentry grant=default access=read 401 unauthorized",
    );
    await expect(
      consumeSandboxEgressAuthRequiredSignal(EGRESS_ID),
    ).resolves.toMatchObject({
      provider: "sentry",
      grant: {
        name: "default",
        access: "read",
      },
    });
  });

  it("clears the cached credential lease so the next request re-issues after upstream 401", async () => {
    setSandboxEgressUserActor();
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
    await expect(firstResponse.text()).resolves.toContain(
      "junior-auth-required provider=sentry grant=default access=read",
    );

    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe("Bearer fresh-token");

    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("returns a command-readable auth marker when provider credentials are missing", async () => {
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock.mockRejectedValue(
      new CredentialUnavailableError(
        "sentry",
        "No sentry credentials available.",
      ),
    );

    const response = await proxy(egressRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=sentry grant=default access=read 401 unauthorized",
    );
  });
});
