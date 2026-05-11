import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
} from "@/chat/services/plugin-auth-orchestration";
import type { Skill } from "@/chat/skills";

const {
  formatProviderLabel,
  getPluginCommandProxies,
  getPluginDefinition,
  getPluginOAuthConfig,
  startOAuthFlow,
  unlinkProvider,
} = vi.hoisted(() => ({
  formatProviderLabel: vi.fn((provider: string) => provider),
  getPluginCommandProxies: vi.fn(),
  getPluginDefinition: vi.fn(),
  getPluginOAuthConfig: vi.fn(),
  startOAuthFlow: vi.fn(),
  unlinkProvider: vi.fn(),
}));

vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel,
  startOAuthFlow,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginCommandProxies,
  getPluginDefinition,
  getPluginOAuthConfig,
}));

vi.mock("@/chat/credentials/unlink-provider", () => ({
  unlinkProvider,
}));

const githubSkill: Skill = {
  name: "github",
  description: "GitHub helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
  allowedTools: ["bash"],
};

const sentrySkill: Skill = {
  name: "sentry",
  description: "Sentry helper",
  skillPath: "/tmp/sentry",
  body: "instructions",
  pluginProvider: "sentry",
  allowedTools: ["bash"],
};

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    formatProviderLabel.mockClear();
    getPluginCommandProxies.mockReset();
    getPluginCommandProxies.mockReturnValue([
      { command: "gh", provider: "github" },
      { command: "git", provider: "github" },
      { command: "sentry", provider: "sentry" },
    ]);
    getPluginDefinition.mockReset();
    getPluginDefinition.mockImplementation((provider: string) => {
      if (provider === "github") {
        return {
          manifest: {
            name: "github",
            credentials: {
              type: "github-app",
              apiDomains: ["api.github.com"],
              authTokenEnv: "GITHUB_TOKEN",
            },
          },
        };
      }

      if (provider === "sentry") {
        return {
          manifest: {
            name: "sentry",
            credentials: {
              type: "oauth-bearer",
              apiDomains: ["sentry.io"],
              authTokenEnv: "SENTRY_AUTH_TOKEN",
            },
          },
        };
      }

      return undefined;
    });
    getPluginOAuthConfig.mockReset();
    getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" || provider === "sentry" ? { provider } : undefined,
    );
    startOAuthFlow.mockReset();
    unlinkProvider.mockReset();
  });

  it("starts oauth recovery for sentry bash commands through provider matching", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const userTokenStore = {} as any;
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: sentrySkill,
        command: "sentry issue list",
        details: {
          exit_code: 1,
          stderr: "401 unauthorized",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry",
      }),
    );
    expect(unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "sentry",
      userTokenStore,
    );
  });

  it("starts oauth recovery from command proxy auth markers without an active skill", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: null,
        command: "cd /tmp && sentry issue list",
        details: {
          exit_code: 91,
          stderr:
            "No sentry credentials available.\nJUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=sentry",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
      }),
    );
  });

  it("ignores command proxy auth markers from unrelated commands", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await orchestration.handleCommandFailure({
      activeSkill: null,
      command:
        "node -e \"process.stderr.write('JUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=sentry'); process.exit(91)\"",
      details: {
        exit_code: 91,
        stderr: "JUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=sentry",
      },
    });

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("unlinks the stored token only after oauth restart is launched", async () => {
    const order: string[] = [];
    const userTokenStore = {} as any;
    const abortAgent = vi.fn();

    startOAuthFlow.mockImplementation(async () => {
      order.push("oauth");
      return {
        ok: true,
        delivery: { channelId: "D123" },
      };
    });
    unlinkProvider.mockImplementation(async () => {
      order.push("unlink");
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore,
      },
      abortAgent,
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "gh issue view 123",
        details: {
          exit_code: 1,
          stderr: "bad credentials",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(order).toEqual(["oauth", "unlink"]);
    expect(unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "github",
      userTokenStore,
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored token when oauth restart cannot be launched", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: false,
      error: "Missing base URL",
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        activeSkill: githubSkill,
        command: "gh issue view 123",
        details: {
          exit_code: 1,
          stderr: "bad credentials",
        },
      }),
    ).rejects.toThrow("Missing base URL");

    expect(unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores auth-like failures for commands unrelated to the provider", async () => {
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore: {} as any,
      },
      vi.fn(),
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

    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(unlinkProvider).not.toHaveBeenCalled();
  });
});
