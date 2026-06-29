import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createPluginEgress } from "@/chat/egress/plugin";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";

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

function authOrchestration() {
  return {
    handleAuthRequired: vi.fn(),
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
    vi.mocked(pluginAuth.handleAuthRequired).mockRejectedValue(
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
    expect(pluginAuth.handleAuthRequired).toHaveBeenCalledWith({
      authorization,
      grant: {
        name: "user-write",
        access: "write",
        reason: "github.issue.create",
      },
      kind: "auth_required",
      message: "Connect GitHub.",
      provider: "github",
    });
  });

  it("rejects non-HTTPS provider URLs before issuing credentials", async () => {
    const issueCredential = vi.fn();
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
          issueCredential,
        },
      }),
    ]);
    const fetchMock = vi.fn();
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: fetchMock as unknown as typeof fetch,
      pluginAuth: authOrchestration(),
    });

    await expect(
      egress.fetch({
        provider: "github",
        operation: "github.repo.get",
        request: new Request("http://api.github.com/repos/getsentry/junior"),
      }),
    ).rejects.toThrow("Plugin egress requires HTTPS provider URLs");
    expect(issueCredential).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
