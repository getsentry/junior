import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createPluginEgress } from "@/chat/egress/plugin";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import type { PluginAuthOrchestration } from "@/chat/services/plugin-auth-orchestration";

function githubManifest() {
  return {
    name: "github",
    displayName: "GitHub",
    description: "GitHub",
    capabilities: [],
    configKeys: [],
    domains: ["api.github.com"],
  };
}

function authOrchestration(): PluginAuthOrchestration {
  return {
    maybeHandleAuthSignal: vi.fn(),
    getPendingPause: () => undefined,
  };
}

describe("plugin egress", () => {
  let restoreCatalog:
    | { previous: ReturnType<typeof pluginCatalogRuntime.setConfig> }
    | undefined;

  beforeEach(() => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    restoreCatalog = {
      previous: pluginCatalogRuntime.setConfig({
        inlineManifests: [{ manifest: githubManifest() }],
      }),
    };
  });

  afterEach(async () => {
    setPlugins([]);
    if (restoreCatalog) {
      pluginCatalogRuntime.setConfig(restoreCatalog.previous);
      restoreCatalog = undefined;
    }
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("forwards plugin provider requests with issued credential headers", async () => {
    const grantForEgress = vi.fn(() => ({
      name: "installation-read",
      access: "read" as const,
      reason: "github.repo.read",
    }));
    const issueCredential = vi.fn(() => ({
      type: "lease" as const,
      lease: {
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: { Authorization: "Bearer github-token" },
          },
        ],
      },
    }));
    setPlugins([
      defineJuniorPlugin({
        manifest: githubManifest(),
        hooks: {
          grantForEgress,
          issueCredential,
        },
      }),
    ]);
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer github-token",
      );
      return Response.json({ ok: true });
    });
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: fetchMock as typeof fetch,
      pluginAuth: authOrchestration(),
    });

    const response = await egress.fetch({
      provider: "github",
      operation: "github.repo.get",
      request: new Request("https://api.github.com/repos/getsentry/junior"),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/getsentry/junior",
    );
    expect(grantForEgress).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          method: "GET",
          operation: "github.repo.get",
          url: "https://api.github.com/repos/getsentry/junior",
        },
      }),
    );
    expect(issueCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { type: "user", userId: "U123" },
        grant: {
          name: "installation-read",
          access: "read",
          reason: "github.repo.read",
        },
      }),
    );
  });

  it("routes missing plugin credentials through auth orchestration", async () => {
    const authorization = {
      type: "oauth" as const,
      provider: "github",
      scope: "repo",
    };
    setPlugins([
      defineJuniorPlugin({
        manifest: githubManifest(),
        hooks: {
          grantForEgress() {
            return {
              name: "user-write",
              access: "write",
              reason: "github.issue.create",
            };
          },
          issueCredential() {
            return {
              type: "needed" as const,
              authorization,
              message: "Connect GitHub.",
            };
          },
        },
      }),
    ]);
    const pluginAuth = authOrchestration();
    vi.mocked(pluginAuth.maybeHandleAuthSignal).mockRejectedValue(
      new Error("paused"),
    );
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: vi.fn() as unknown as typeof fetch,
      pluginAuth,
    });

    await expect(
      egress.fetch({
        provider: "github",
        operation: "github.issue.create",
        request: new Request(
          "https://api.github.com/repos/getsentry/junior/issues",
          {
            method: "POST",
            body: JSON.stringify({ title: "Test" }),
          },
        ),
      }),
    ).rejects.toThrow("paused");
    expect(pluginAuth.maybeHandleAuthSignal).toHaveBeenCalledWith({
      auth_required: expect.objectContaining({
        authorization,
        grant: {
          name: "user-write",
          access: "write",
          reason: "github.issue.create",
        },
        kind: "auth_required",
        message: "Connect GitHub.",
        provider: "github",
      }),
    });
  });

  it("returns upstream permission denied responses to plugin callers", async () => {
    setPlugins([
      defineJuniorPlugin({
        manifest: githubManifest(),
        hooks: {
          grantForEgress() {
            return {
              name: "installation-read",
              access: "read",
              reason: "github.repo.read",
            };
          },
          issueCredential() {
            return {
              type: "lease" as const,
              lease: {
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                headerTransforms: [
                  {
                    domain: "api.github.com",
                    headers: { Authorization: "Bearer github-token" },
                  },
                ],
              },
            };
          },
        },
      }),
    ]);
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: vi.fn(async () => new Response("forbidden", { status: 403 })),
      pluginAuth: authOrchestration(),
    });

    const response = await egress.fetch({
      provider: "github",
      operation: "github.repo.get",
      request: new Request("https://api.github.com/repos/getsentry/junior"),
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("forbidden");
  });
});
