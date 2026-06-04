import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineJuniorPlugin,
  type IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { consumeSandboxEgressPermissionDeniedSignal } from "@/chat/sandbox/egress-session";
import {
  activeSandboxEgressCredentialToken,
  cleanupSandboxEgressProxyTest,
  createSandboxEgressCredentialToken,
  CredentialUnavailableError,
  egressRequest,
  EGRESS_ID,
  getPluginProvidersMock,
  githubPlugin,
  issueProviderCredentialLeaseMock,
  mockGitHubLease,
  mockSentryLease,
  proxy,
  REQUESTER_ID,
  setActiveSandboxEgressCredentialToken,
  setSandboxEgressSystemActor,
  setSandboxEgressUserActor,
  setupSandboxEgressProxyTest,
} from "../../fixtures/sandbox-egress-proxy";

describe("sandbox egress credentials", () => {
  beforeEach(async () => {
    await setupSandboxEgressProxyTest();
  });

  afterEach(async () => {
    await cleanupSandboxEgressProxyTest();
  });

  it("rejects unbound delegated credential subjects under signed egress contexts", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setActiveSandboxEgressCredentialToken(
      createSandboxEgressCredentialToken({
        credentials: {
          actor: { type: "system", id: "scheduler" },
          subject: {
            type: "user",
            userId: REQUESTER_ID,
            allowedWhen: "private-direct-conversation",
          } as any,
        },
        egressId: EGRESS_ID,
        ttlMs: 60_000,
      }),
    );

    const response = await proxy(
      egressRequest({
        host: "api.github.com",
        path: "/repos/getsentry/junior/issues/449",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Sandbox egress credential context is not authorized",
    });
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("preserves delegated credential subjects under system actor contexts", async () => {
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    setSandboxEgressSystemActor({
      subject: {
        type: "user",
        userId: REQUESTER_ID,
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: "T123",
          channelId: "D123",
          signature: "v1=test",
        },
      },
    });
    mockGitHubLease();

    const response = await proxy(
      egressRequest({
        host: "api.github.com",
        path: "/repos/getsentry/junior/issues/449",
      }),
    );

    expect(response.status).toBe(200);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledWith({
      context: {
        actor: { type: "system", id: "scheduler" },
        subject: {
          type: "user",
          userId: REQUESTER_ID,
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: "v1=test",
          },
        },
      },
      provider: "github",
      reason: "sandbox-egress:github:read",
    });
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
      context: { actor: { type: "user", userId: REQUESTER_ID } },
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

  it("returns a command-readable auth marker when upstream rejects the injected credential", async () => {
    setSandboxEgressUserActor();
    mockSentryLease();

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
      "junior-auth-required provider=sentry",
    );

    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    await expect(secondResponse.text()).resolves.toBe("Bearer fresh-token");

    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("passes through upstream 403 responses without overriding the body", async () => {
    setSandboxEgressUserActor();
    issueProviderCredentialLeaseMock
      .mockResolvedValueOnce({
        id: "lease-1",
        provider: "sentry",
        env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
        headerTransforms: [
          { domain: "sentry.io", headers: { Authorization: "Bearer token" } },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .mockResolvedValueOnce({
        id: "lease-2",
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

    const secondResponse = await proxy(
      egressRequest({ path: "/api/0/issues/2" }),
      fetchMock as typeof fetch,
    );
    expect(secondResponse.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).toHaveBeenCalledTimes(2);
  });

  it("records current GitHub grant reason and smart HTTP target on cached-lease 403", async () => {
    setSandboxEgressUserActor();
    getPluginProvidersMock.mockReturnValue([githubPlugin()]);
    const issueCredential = vi.fn((ctx: IssueCredentialHookContext) => {
      expect(ctx.grant).toMatchObject({
        name: "user-write",
        access: "write",
        reason: "github.graphql-write",
      });
      return {
        type: "lease" as const,
        lease: {
          account: {
            id: "12345",
            label: "requester",
            url: "https://github.com/requester",
          },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: { Authorization: "Bearer github-user-token" },
            },
            {
              domain: "github.com",
              headers: { Authorization: "Bearer github-user-token" },
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
            if (ctx.request.url === "https://api.github.com/graphql") {
              return {
                name: "user-write",
                access: "write",
                reason: "github.graphql-write",
              };
            }
            return {
              name: "user-write",
              access: "write",
              reason: "github.git-write",
            };
          },
          issueCredential,
        },
      }),
    ]);
    try {
      const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer github-user-token",
        );
        if (String(url) === "https://api.github.com/graphql") {
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

      const graphqlResponse = await proxy(
        egressRequest({
          host: "api.github.com",
          method: "POST",
          path: "/graphql",
          body: "{}",
        }),
        fetchMock as typeof fetch,
      );
      expect(graphqlResponse.status).toBe(200);

      const response = await proxy(
        egressRequest({
          host: "github.com",
          path: "/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
        }),
        fetchMock as typeof fetch,
      );

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toBe("write denied");
      expect(issueCredential).toHaveBeenCalledTimes(1);
      await expect(
        consumeSandboxEgressPermissionDeniedSignal(EGRESS_ID),
      ).resolves.toMatchObject({
        provider: "github",
        account: {
          id: "12345",
          label: "requester",
          url: "https://github.com/requester",
        },
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.git-write",
        },
        message:
          "github returned HTTP 403 after Junior injected the user-write grant. Junior forwarded the request; this is not a local runtime block.",
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
    await expect(response.text()).resolves.toContain(
      "junior-auth-required provider=sentry grant=default access=read 401 unauthorized",
    );
  });

  it("requires a signed credential context", async () => {
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("rejects credential context tokens from a different sandbox session", async () => {
    setActiveSandboxEgressCredentialToken(
      createSandboxEgressCredentialToken({
        credentials: { actor: { type: "user", userId: REQUESTER_ID } },
        egressId: "different-egress-session",
        ttlMs: 60_000,
      }),
    );
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });

  it("rejects tampered credential tokens", async () => {
    setSandboxEgressUserActor();
    setActiveSandboxEgressCredentialToken(
      `${activeSandboxEgressCredentialToken() ?? ""}tampered`,
    );
    mockSentryLease();

    const response = await proxy(egressRequest());

    expect(response.status).toBe(403);
    expect(issueProviderCredentialLeaseMock).not.toHaveBeenCalled();
  });
});
