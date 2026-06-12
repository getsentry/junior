import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
  PluginCredentialFailureError,
} from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import type { PluginManifest } from "@/chat/plugins/types";
import { mockTestClock } from "../../fixtures/vitest";

type PluginAuthServices = NonNullable<
  Parameters<typeof createPluginAuthOrchestration>[1]
>;

const pluginManifests = {
  github: {
    name: "github",
    displayName: "GitHub",
    description: "GitHub provider",
    capabilities: [],
    configKeys: [],
    domains: ["api.github.com", "github.com"],
    oauth: {
      clientIdEnv: "GITHUB_CLIENT_ID",
      clientSecretEnv: "GITHUB_CLIENT_SECRET",
      authorizeEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
    },
  },
  sentry: {
    name: "sentry",
    displayName: "Sentry",
    description: "Sentry provider",
    capabilities: [],
    configKeys: [],
    credentials: {
      type: "oauth-bearer",
      domains: ["sentry.io"],
      authTokenEnv: "SENTRY_AUTH_TOKEN",
    },
    oauth: {
      clientIdEnv: "SENTRY_CLIENT_ID",
      clientSecretEnv: "SENTRY_CLIENT_SECRET",
      authorizeEndpoint: "https://sentry.io/oauth/authorize/",
      tokenEndpoint: "https://sentry.io/oauth/token/",
    },
  },
} satisfies Record<string, PluginManifest>;

const sentryAuthSignal = {
  provider: "sentry",
  grant: { name: "default", access: "read" as const },
  authorization: { type: "oauth" as const, provider: "sentry" },
  createdAtMs: 1_700_000_000_000,
};

function configurePluginCatalog(): void {
  setPluginCatalogConfig({
    inlineManifests: Object.values(pluginManifests).map((manifest) => ({
      manifest,
    })),
  });
}

function createPluginAuthServices() {
  return {
    recordAuthorizationRequested: vi.fn(async () => undefined),
    startOAuthFlow: vi.fn<PluginAuthServices["startOAuthFlow"]>(),
    unlinkProvider: vi.fn(async () => undefined),
  } satisfies PluginAuthServices;
}

function createTestUserTokenStore(): UserTokenStore {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

function createInput(
  overrides: Partial<Parameters<typeof createPluginAuthOrchestration>[0]> = {},
): Parameters<typeof createPluginAuthOrchestration>[0] {
  return {
    requesterId: "U123",
    userMessage: "check Sentry",
    userTokenStore: createTestUserTokenStore(),
    ...overrides,
  };
}

async function expectPluginCredentialFailure(
  promise: Promise<unknown>,
  expected: { message: string; provider: string },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginCredentialFailureError);
  expect(caught).toMatchObject(expected);
}

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    mockTestClock(1_700_000_000_000);
    configurePluginCatalog();
  });

  afterEach(() => {
    setPluginCatalogConfig(undefined);
    vi.useRealTimers();
  });

  it("starts oauth from a structured auth_required signal", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const abortAgent = vi.fn();
    const userTokenStore = createTestUserTokenStore();
    const orchestration = createPluginAuthOrchestration(
      createInput({ userTokenStore }),
      abortAgent,
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 0,
        stderr: "401 unauthorized",
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

  it("requires a pending-auth recorder before starting a resumable oauth flow", async () => {
    const services = createPluginAuthServices();
    services.startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: "fallback_dm",
    });
    const abortAgent = vi.fn();
    const orchestration = createPluginAuthOrchestration(
      createInput({
        conversationId: "slack:C123:1700000000.000000",
        sessionId: "run_new",
      }),
      abortAgent,
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toThrow(
      'Missing pending auth recorder for plugin authorization pause "sentry"',
    );

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("reuses a fresh pending oauth link without starting a duplicate flow", async () => {
    const services = createPluginAuthServices();
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn(async () => undefined);
    const userTokenStore = createTestUserTokenStore();
    const orchestration = createPluginAuthOrchestration(
      createInput({
        conversationId: "slack:C123:1700000000.000000",
        sessionId: "scheduled:sched_1:1000",
        pendingAuth: {
          kind: "plugin",
          provider: "sentry",
          requesterId: "U123",
          sessionId: "scheduled:sched_1:1000",
          linkSentAtMs: 1_699_999_999_000,
        },
        recordPendingAuth,
        userTokenStore,
      }),
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

  it("does not start oauth or abort when authorization is disabled", async () => {
    const services = createPluginAuthServices();
    const abortAgent = vi.fn();
    const orchestration = createPluginAuthOrchestration(
      createInput({ authorizationFlowMode: "disabled" }),
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

  it("surfaces non-oauth auth signals as credential failures", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      createInput({ userMessage: "inspect a repo" }),
      vi.fn(),
      services,
    );

    await expectPluginCredentialFailure(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "installation-read", access: "read" as const },
          createdAtMs: 1_700_000_000_000,
          message: "Missing GITHUB_APP_ID",
        },
      }),
      { provider: "github", message: "Missing GITHUB_APP_ID" },
    );

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores auth-like output without a structured signal", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      createInput({ userMessage: "check GitHub" }),
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
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores auth_required payloads that fail schema validation", async () => {
    const services = createPluginAuthServices();
    const orchestration = createPluginAuthOrchestration(
      createInput({ userMessage: "create an issue" }),
      vi.fn(),
      services,
    );

    await expect(
      orchestration.maybeHandleAuthSignal({
        auth_required: {
          provider: "github",
          grant: { name: "user-write", access: "write" },
          authorization: { type: "oauth", provider: "sentry" },
          createdAtMs: 1_700_000_000_000,
        },
      }),
    ).resolves.toBeUndefined();

    expect(services.startOAuthFlow).not.toHaveBeenCalled();
    expect(services.unlinkProvider).not.toHaveBeenCalled();
  });
});
