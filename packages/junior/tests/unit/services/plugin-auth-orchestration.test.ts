import { describe, expect, it, vi } from "vitest";
import type {
  OAuthProviderConfig,
  PluginDefinition,
} from "@/chat/plugins/types";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
  PluginCredentialFailureError,
} from "@/chat/services/plugin-auth-orchestration";

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

function createPluginAuthServices() {
  return {
    formatProviderLabel: vi.fn((provider: string) => provider),
    getPluginProviders: vi.fn(() => Object.values(pluginDefinitions)),
    getPluginOAuthConfig: vi.fn((provider: string) =>
      provider === "sentry" ? sentryOAuthConfig : undefined,
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

async function expectPluginCredentialFailure(
  promise: Promise<unknown>,
  expected: { message: string; provider: string },
) {
  await expect(promise).rejects.toMatchObject({
    name: "PluginCredentialFailureError",
    message: expected.message,
    provider: expected.provider,
  });
}

describe("createPluginAuthOrchestration", () => {
  it("starts oauth recovery from a structured provider auth signal", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const userTokenStore = tokenStore();
    const abortAgent = vi.fn();

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
      orchestration.maybeHandleAuthSignal({
        exit_code: 30,
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
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("returns AuthorizationFlowDisabledError when oauth recovery is disabled", async () => {
    const services = createPluginAuthServices();
    const abortAgent = vi.fn();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore: tokenStore(),
        authorizationFlowMode: "disabled",
      },
      abortAgent,
      services,
    );

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

  it("reuses a pending oauth link using the injected clock", async () => {
    const services = createPluginAuthServices();
    const userTokenStore = tokenStore();
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn(async () => undefined);
    const orchestration = createPluginAuthOrchestration(
      {
        conversationId: "slack:C123:1700000000.000000",
        sessionId: "scheduled:sched_1:1000",
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
        pendingAuth: {
          kind: "plugin",
          provider: "sentry",
          requesterId: "U123",
          sessionId: "scheduled:sched_1:1000",
          linkSentAtMs: 1_699_999_999_000,
        },
        recordPendingAuth,
      },
      abortAgent,
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "sentry",
      userTokenStore,
    );
    expect(recordPendingAuth).toHaveBeenCalledWith({
      kind: "plugin",
      provider: "sentry",
      requesterId: "U123",
      sessionId: "scheduled:sched_1:1000",
      linkSentAtMs: 1_699_999_999_000,
    });
    expect(services.recordAuthorizationRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: "scheduled:sched_1:1000:plugin:sentry",
        delivery: "private_link_reused",
      }),
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

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toThrow("Missing base URL");

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

  it("starts oauth recovery from a provider signal without an active skill", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const recordPendingAuth = vi.fn(async () => undefined);
    const orchestration = createPluginAuthOrchestration(
      {
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
        recordPendingAuth,
      },
      vi.fn(),
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        auth_required: sentryAuthSignal,
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
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "inspect a repo",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          createdAtMs: Date.now(),
        },
      }),
      {
        provider: "github",
        message: "github credentials are unavailable.",
      },
    );

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
  });

  it("preserves unavailable auth signal messages without starting oauth", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "inspect a repo",
        userTokenStore: tokenStore(),
      },
      vi.fn(),
      services,
    );

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

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
  });

  it("no-ops when no auth_required field is in the result", async () => {
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
      orchestration.maybeHandleAuthSignal({
        exit_code: 1,
        stderr: "401 unauthorized bad credentials missing scope",
      }),
    ).resolves.toBeUndefined();

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
  });

  it("no-ops for unregistered providers and invalid auth signals", async () => {
    const services = createPluginAuthServices();
    services.getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" ? githubOAuthConfig : undefined,
    );
    const inputs = [
      {
        auth_required: {
          provider: "linear",
          grant: { name: "user-write", access: "write" as const },
          authorization: { type: "oauth" as const, provider: "linear" },
          createdAtMs: Date.now(),
        },
      },
      {
        auth_required: {
          provider: "github",
          grant: { name: "user-write", access: "write" as const },
          authorization: { type: "oauth" as const, provider: "sentry" },
          createdAtMs: Date.now(),
        },
      },
    ];

    for (const input of inputs) {
      const orchestration = createPluginAuthOrchestration(
        {
          requesterId: "U123",
          userMessage: "create an issue",
          userTokenStore: tokenStore(),
        },
        vi.fn(),
        services,
      );

      await expect(orchestration.maybeHandleAuthSignal(input)).resolves.toBeUndefined();
    }

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });
});
