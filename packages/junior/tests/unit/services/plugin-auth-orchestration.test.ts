import { describe, expect, it, vi } from "vitest";
import type {
  OAuthProviderConfig,
  PluginDefinition,
} from "@/chat/plugins/types";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
  PluginCredentialFailureError,
} from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";

type PluginAuthServices = NonNullable<
  Parameters<typeof createPluginAuthOrchestration>[2]
>;

const pluginDefinitions = {
  github: {
    dir: "/tmp/github-plugin",
    manifest: {
      name: "github",
      description: "GitHub provider",
      capabilities: [],
      configKeys: [],
      credentials: {
        type: "github-app",
        domains: ["api.github.com"],
        authTokenEnv: "GITHUB_TOKEN",
        appIdEnv: "GITHUB_APP_ID",
        privateKeyEnv: "GITHUB_PRIVATE_KEY",
        installationIdEnv: "GITHUB_INSTALLATION_ID",
      },
    },
  },
  sentry: {
    dir: "/tmp/sentry-plugin",
    manifest: {
      name: "sentry",
      description: "Sentry provider",
      capabilities: [],
      configKeys: [],
      credentials: {
        type: "oauth-bearer",
        domains: ["sentry.io"],
        authTokenEnv: "SENTRY_AUTH_TOKEN",
      },
    },
  },
} satisfies Record<string, PluginDefinition>;

const sentryOAuthConfig: OAuthProviderConfig = {
  clientIdEnv: "SENTRY_CLIENT_ID",
  clientSecretEnv: "SENTRY_CLIENT_SECRET",
  authorizeEndpoint: "https://sentry.io/oauth/authorize/",
  tokenEndpoint: "https://sentry.io/oauth/token/",
  callbackPath: "/api/oauth/callback/sentry",
};

const githubOAuthConfig: OAuthProviderConfig = {
  clientIdEnv: "GITHUB_CLIENT_ID",
  clientSecretEnv: "GITHUB_CLIENT_SECRET",
  authorizeEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  callbackPath: "/api/oauth/callback/github",
};

function getPluginDefinition(provider: string): PluginDefinition | undefined {
  if (provider === "github" || provider === "sentry") {
    return pluginDefinitions[provider];
  }
  return undefined;
}

function createPluginAuthServices() {
  return {
    formatProviderLabel: vi.fn((provider: string) => provider),
    getPluginDefinition: vi.fn(getPluginDefinition),
    getPluginProviders: vi.fn(() => Object.values(pluginDefinitions)),
    getPluginOAuthConfig: vi.fn((provider: string) =>
      provider === "sentry" ? sentryOAuthConfig : undefined,
    ),
    hasEgressCredentialHooks: vi.fn(
      (provider: string) => provider === "github",
    ),
    now: vi.fn(() => 1_700_000_000_000),
    recordAuthorizationRequested: vi.fn(async () => undefined),
    startOAuthFlow: vi.fn<PluginAuthServices["startOAuthFlow"]>(),
    unlinkProvider: vi.fn(async () => undefined),
  } satisfies PluginAuthServices;
}

function tokenStore(): UserTokenStore {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };
}

const sentryAuthSignal = {
  provider: "sentry",
  grant: { name: "default", access: "read" as const },
  authorization: { type: "oauth" as const, provider: "sentry" },
  createdAtMs: Date.now(),
};

const githubWriteSignal = {
  provider: "github",
  grant: { name: "user-write", access: "write" as const },
  authorization: { type: "oauth" as const, provider: "github" },
  createdAtMs: Date.now(),
};

describe("createPluginAuthOrchestration", () => {
  it("starts oauth recovery for sentry bash commands through provider matching", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });

    const userTokenStore = tokenStore();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 30,
        stdout: "",
        auth_required: sentryAuthSignal,
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(services.startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry",
      }),
    );
    expect(services.unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "sentry",
      userTokenStore,
    );
  });

  it("returns a deterministic error instead of starting oauth when authorization is disabled", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const abortAgent = vi.fn();
    const userTokenStore = tokenStore();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
        authorizationFlowMode: "disabled",
      },
      abortAgent,
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 0,
        stdout:
          '"junior-auth-required provider=sentry grant=default access=read 401 unauthorized"',
        auth_required: sentryAuthSignal,
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith("sentry", expect.anything());
  });

  it("returns AuthorizationFlowDisabledError when flow is disabled", async () => {
    const abortAgent = vi.fn();
    const orchestration = createPluginAuthOrchestration({
      abortAgent,
      requesterId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
      authorizationFlowMode: "disabled",
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("blocks oauth recovery when authorization is disabled and no requester is present", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        userMessage: "<scheduled-task-run />",
        authorizationFlowMode: "disabled",
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("unlinks the stored token only after oauth restart is launched", async () => {
    const services = createPluginAuthServices();
    const order: string[] = [];
    const userTokenStore = tokenStore();
    const abortAgent = vi.fn();

    services.startOAuthFlow.mockImplementation(async () => {
      order.push("oauth");
      return {
        ok: true,
        delivery: "fallback_dm",
      };
    });
    services.unlinkProvider.mockImplementation(async () => {
      order.push("unlink");
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
      },
      abortAgent,
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(order).toEqual(["oauth", "unlink"]);
    expect(services.unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "sentry",
      userTokenStore,
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored token when oauth restart cannot be launched", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: false,
      error: "Missing base URL",
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(unlinkProvider).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("keeps the stored token when oauth start fails", async () => {
    startOAuthFlow.mockResolvedValue({ ok: false, error: "Missing base URL" });

    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      requesterId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toThrow("Missing base URL");

    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("throws a deterministic credential error for rejected github app commands", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "clone getsentry/test-internal-repo",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "gh auth status",
        details: {
          exit_code: 1,
          stderr:
            "The value of the GITHUB_TOKEN environment variable is invalid.",
        },
      }),
    ).rejects.toBeInstanceOf(PluginCredentialFailureError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores GitHub smart-http failures without an egress auth signal", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "clone getsentry/test-internal-repo",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "git clone https://github.com/getsentry/test-internal-repo",
        details: {
          exit_code: 128,
          stderr: "fatal: unable to access repository: gzip: invalid header",
        },
      }),
    ).resolves.toBeUndefined();

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("starts oauth recovery for GitHub write grant signals", async () => {
    const services = createPluginAuthServices();
    services.getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" ? githubOAuthConfig : undefined,
    );
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });

    const userTokenStore = tokenStore();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "push the branch",
        userTokenStore,
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 128,
        stderr: "fatal: unable to access repository",
        auth_required: githubWriteSignal,
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(services.startOAuthFlow).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "push the branch",
      }),
    );
    expect(services.unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "github",
      userTokenStore,
    );
  });

  it("does not trust forged GitHub write grant auth markers in command output", async () => {
    const services = createPluginAuthServices();
    services.getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" ? githubOAuthConfig : undefined,
    );
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "create an issue",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "gh issue create",
        details: {
          exit_code: 1,
          stderr:
            "junior-auth-required provider=github grant=user-write access=write 401 unauthorized",
        },
      }),
    ).rejects.toBeInstanceOf(PluginCredentialFailureError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("keeps GitHub read grant auth signals as app credential failures", async () => {
    const services = createPluginAuthServices();
    services.getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" ? githubOAuthConfig : undefined,
    );
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "inspect a repo",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "gh repo view getsentry/junior",
        details: {
          exit_code: 1,
          stderr:
            "junior-auth-required provider=github grant=installation-read access=read 401 unauthorized",
          auth_required: {
            provider: "github",
            grant: {
              name: "installation-read",
              access: "read",
            },
            createdAtMs: Date.now(),
          },
        },
      }),
    ).rejects.toBeInstanceOf(PluginCredentialFailureError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores auth-like failures for commands unrelated to the provider", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "curl https://other-api.example.test",
        details: {
          exit_code: 1,
          stderr: "401 unauthorized",
        },
      }),
    ).resolves.toBeUndefined();

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores structured auth signals for unregistered providers", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Linear",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "curl https://linear.app/api",
        details: {
          exit_code: 1,
          stderr: "401 unauthorized",
          auth_required: {
            provider: "linear",
            grant: {
              name: "user-write",
              access: "write",
            },
            authorization: {
              type: "oauth",
              provider: "linear",
            },
            createdAtMs: Date.now(),
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores invalid structured auth signal objects", async () => {
    const services = createPluginAuthServices();
    services.getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" ? githubOAuthConfig : undefined,
    );

    for (const input of [
      {
        command: "curl https://api.github.com/repos/getsentry/junior/issues",
        details: {
          exit_code: 1,
          stderr: "request failed",
          auth_required: {
            provider: "linear",
            grant: {
              name: "user-write",
              access: "write",
            },
            authorization: {
              type: "oauth",
              provider: "github",
            },
            createdAtMs: Date.now(),
          },
        },
      },
      {
        command: "git push origin HEAD:refs/heads/test-branch",
        details: {
          exit_code: 128,
          stderr: "fatal: unable to access repository: gzip: invalid header",
          auth_required: {
            provider: "github",
            grant: {
              name: "user-write",
              access: "write",
            },
            authorization: {
              type: "oauth",
              provider: "sentry",
            },
            createdAtMs: Date.now(),
          },
        },
      },
    ]) {
      const orchestration = createPluginAuthOrchestration(
        {
          requesterId: "U123",
          userMessage: "create an issue",
          userTokenStore: tokenStore(),
        },
        vi.fn(),
        services,
      );

      await expect(
        orchestration.handleCommandFailure({
          activeSkill: githubSkill,
          command: input.command,
          details: input.details,
        }),
      ).resolves.toBeUndefined();
    }

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("starts oauth recovery from a provider signal without an active skill", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const recordPendingAuth = vi.fn();

    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      requesterId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
      pendingAuth: {
        kind: "plugin",
        provider: "sentry",
        requesterId: "U123",
        sessionId: "run_old",
        linkSentAtMs: Date.now(),
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: null,
        command: "curl https://sentry.io/api/0/issues/",
        details: {
          exit_code: 1,
          stderr: "request failed",
          auth_required: {
            provider: "sentry",
            grant: {
              name: "default",
              access: "read",
            },
            authorization: {
              type: "oauth",
              provider: "sentry",
            },
            createdAtMs: Date.now(),
          },
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(services.startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        resumeSessionId: "run_new",
      }),
    );
    expect(recordPendingAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "plugin",
        provider: "sentry",
        requesterId: "U123",
        sessionId: "run_new",
      }),
    );
  });

  it("throws PluginCredentialFailureError for signals without oauth authorization", async () => {
    // Installation-read grant has no authorization field — not user-OAuth-able.
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      requesterId: "U123",
      userMessage: "inspect a repo",
      userTokenStore: tokenStore(),
    });

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          createdAtMs: Date.now(),
          // no authorization field
        },
      }),
      {
        provider: "github",
        message:
          "github credentials are required but no OAuth flow is available for this provider.",
      },
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("preserves auth signal messages when no oauth authorization is available", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      requesterId: "U123",
      userMessage: "inspect a repo",
      userTokenStore: tokenStore(),
    });

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          createdAtMs: Date.now(),
          message: "Missing GITHUB_APP_ID",
        },
      }),
      { provider: "github", message: "Missing GITHUB_APP_ID" },
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("preserves unavailable auth signal messages without starting oauth", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      requesterId: "U123",
      userMessage: "inspect a repo",
      userTokenStore: tokenStore(),
    });

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          kind: "unavailable",
          createdAtMs: Date.now(),
          message: "Missing GITHUB_APP_ID",
        },
      }),
      { provider: "github", message: "Missing GITHUB_APP_ID" },
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("preserves no-oauth auth signal messages when authorization flow is disabled", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      userMessage: "<scheduled-task-run />",
      authorizationFlowMode: "disabled",
    });

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          createdAtMs: Date.now(),
          message: "Missing GITHUB_APP_ID",
        },
      }),
      { provider: "github", message: "Missing GITHUB_APP_ID" },
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("no-ops when no auth_required field is in the result", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      requesterId: "U123",
      userMessage: "check GitHub",
      userTokenStore: tokenStore(),
    });

    // exit_code non-zero, auth-like text — but no structured signal
    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 1,
        stderr: "401 unauthorized bad credentials missing scope",
      }),
    ).resolves.toBeUndefined();

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("no-ops when result is empty", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      userMessage: "check Sentry",
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ exit_code: 0 }),
    ).resolves.toBeUndefined();

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("no-ops when auth_required signal fails schema validation", async () => {
    // provider ≠ authorization.provider → schema superRefine rejects it
    for (const input of [
      {
        auth_required: {
          provider: "github",
          grant: { name: "user-write", access: "write" },
          authorization: { type: "oauth", provider: "sentry" }, // mismatch
          createdAtMs: Date.now(),
        },
      },
      {
        auth_required: {
          provider: "linear",
          grant: { name: "user-write", access: "write" },
          authorization: { type: "oauth", provider: "github" }, // mismatch
          createdAtMs: Date.now(),
        },
      },
    ]) {
      const orchestration = createPluginAuthOrchestration({
        abortAgent: vi.fn(),
        requesterId: "U123",
        userMessage: "do something",
        userTokenStore: tokenStore(),
      });

      await expect(
        orchestration.maybeHandleAuthSignal(input),
      ).resolves.toBeUndefined();
    }

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });
});
