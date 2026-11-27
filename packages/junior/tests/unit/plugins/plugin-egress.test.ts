import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createPluginEgress } from "@/chat/egress/plugin";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { useAppContext } from "../../fixtures/app-context";

function githubManifest() {
  return {
    name: "github",
    displayName: "GitHub",
    description: "GitHub",
    configKeys: [],
    domains: ["api.github.com"],
  };
}

const githubCatalogConfig = {
  inlineManifests: [{ manifest: githubManifest() }],
};

function authOrchestration() {
  return {
    handleAuthRequired: vi.fn(),
  };
}

describe("plugin egress", () => {
  beforeEach(() => {
    process.env["JUNIOR_STATE_ADAPTER"] = "memory";
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("routes missing plugin credentials through auth orchestration", async () => {
    const authorization = {
      type: "oauth" as const,
      provider: "github",
      scope: "repo",
    };
    useAppContext({
      pluginConfig: githubCatalogConfig,
      plugins: [
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
      ],
    });
    const pluginAuth = authOrchestration();
    vi.mocked(pluginAuth.handleAuthRequired).mockRejectedValue(
      new Error("paused"),
    );
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: vi.fn() as typeof fetch,
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
    useAppContext({
      pluginConfig: githubCatalogConfig,
      plugins: [
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
      ],
    });
    const fetchMock = vi.fn();
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: fetchMock as typeof fetch,
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
    useAppContext({
      pluginConfig: githubCatalogConfig,
      plugins: [
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
      ],
    });
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

  it("denies pull request approvals on plugin egress even when operation is set", async () => {
    useAppContext({
      pluginConfig: githubCatalogConfig,
      plugins: [githubPlugin()],
    });
    const fetchMock = vi.fn();
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U123" } },
      fetch: fetchMock as typeof fetch,
      pluginAuth: authOrchestration(),
    });

    const response = await egress.fetch({
      provider: "github",
      operation: "github.pull.update",
      request: new Request(
        "https://api.github.com/repos/getsentry/junior/pulls/780/reviews",
        {
          method: "POST",
          body: JSON.stringify({ event: "APPROVE", body: "lgtm" }),
        },
      ),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "You cannot approve GitHub pull requests. Request changes, leave a comment review, or dismiss your own review instead.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
