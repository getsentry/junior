import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
  PluginCredentialFailureError,
} from "@/chat/services/plugin-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";

const {
  formatProviderLabel,
  getOAuthConfigMock,
  startOAuthFlow,
  unlinkProvider,
} = vi.hoisted(() => ({
  formatProviderLabel: vi.fn((provider: string) => provider),
  getOAuthConfigMock: vi.fn(),
  startOAuthFlow: vi.fn(),
  unlinkProvider: vi.fn(),
}));

vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel,
  startOAuthFlow,
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getOAuthConfig: getOAuthConfigMock,
  },
}));

vi.mock("@/chat/credentials/unlink-provider", () => ({
  unlinkProvider,
}));

function tokenStore(): UserTokenStore {
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    withRefresh: vi.fn(async (_userId, _provider, callback) => callback()),
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

const slackSource = createSlackSource({
  teamId: "T123",
  channelId: "C123",
  messageTs: "1700000000.source",
  threadTs: "1700000000.000000",
  type: "priv",
});

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    formatProviderLabel.mockClear();
    getOAuthConfigMock.mockReset();
    getOAuthConfigMock.mockImplementation((provider: string) =>
      provider === "sentry" || provider === "github" ? { provider } : undefined,
    );
    startOAuthFlow.mockReset();
    unlinkProvider.mockReset();
  });

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

  it("starts oauth for sentry when auth_required signal is present", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const tokens = tokenStore();
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      actorId: "U123",
      source: slackSource,
      userMessage: "check Sentry",
      userTokenStore: tokens,
    });

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 30,
        stdout: "",
        auth_required: sentryAuthSignal,
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        actorId: "U123",
        source: slackSource,
        userMessage: "check Sentry",
      }),
    );
    expect(unlinkProvider).toHaveBeenCalledWith("U123", "sentry", tokens);
  });

  it("starts oauth when exit code is 0 (pipe-masked failure)", async () => {
    // Regression: `sentry org list | head` exits 0 even though sentry exited 30.
    // Auth must still trigger based on the structured egress signal alone.
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const tokens = tokenStore();
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokens,
    });

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
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
      authorizationFlowMode: "disabled",
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("returns AuthorizationFlowDisabledError when no actor and flow is disabled", async () => {
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      userMessage: "<scheduled-task-run />",
      authorizationFlowMode: "disabled",
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("unlinks the stored token only after oauth restart is launched", async () => {
    const order: string[] = [];
    const tokens = tokenStore();
    const abortAgent = vi.fn();

    startOAuthFlow.mockImplementation(async () => {
      order.push("oauth");
      return { ok: true, delivery: { channelId: "D123" } };
    });
    unlinkProvider.mockImplementation(async () => {
      order.push("unlink");
    });

    const orchestration = createPluginAuthOrchestration({
      abortAgent,
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokens,
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(order).toEqual(["oauth", "unlink"]);
    expect(unlinkProvider).toHaveBeenCalledWith("U123", "sentry", tokens);
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("fails before starting oauth when pending auth cannot be recorded", async () => {
    const abortAgent = vi.fn();
    const orchestration = createPluginAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toThrow(
      'Missing pending auth recorder for plugin authorization pause "sentry"',
    );

    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(unlinkProvider).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("keeps the stored token when oauth start fails", async () => {
    startOAuthFlow.mockResolvedValue({ ok: false, error: "Missing base URL" });

    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toThrow("Missing base URL");

    expect(unlinkProvider).not.toHaveBeenCalled();
  });

  it("starts oauth for GitHub write grant signal", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const tokens = tokenStore();
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      actorId: "U123",
      userMessage: "push the branch",
      userTokenStore: tokens,
    });

    await expect(
      orchestration.maybeHandleAuthSignal({
        exit_code: 128,
        stderr: "fatal: unable to access repository",
        auth_required: githubWriteSignal,
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        actorId: "U123",
        userMessage: "push the branch",
      }),
    );
    expect(unlinkProvider).toHaveBeenCalledWith("U123", "github", tokens);
  });

  it("sends a fresh link when the pending auth belongs to a previous session", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });
    const recordPendingAuth = vi.fn();

    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      actorId: "U123",
      userMessage: "check Sentry",
      userTokenStore: tokenStore(),
      pendingAuth: {
        kind: "plugin",
        provider: "sentry",
        actorId: "U123",
        sessionId: "run_old",
        linkSentAtMs: Date.now(),
      },
      recordPendingAuth,
    });

    await expect(
      orchestration.maybeHandleAuthSignal({ auth_required: sentryAuthSignal }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        resumeSessionId: "run_new",
      }),
    );
    expect(recordPendingAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "plugin",
        provider: "sentry",
        actorId: "U123",
        sessionId: "run_new",
      }),
    );
  });

  it("throws PluginCredentialFailureError for signals without oauth authorization", async () => {
    // Installation-read grant has no authorization field — not user-OAuth-able.
    const orchestration = createPluginAuthOrchestration({
      abortAgent: vi.fn(),
      actorId: "U123",
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
      actorId: "U123",
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
      actorId: "U123",
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
      actorId: "U123",
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
        actorId: "U123",
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
