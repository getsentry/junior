import { beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialUnavailableError } from "@/chat/credentials/broker";

const { startOAuthFlowMock, unlinkProviderMock } = vi.hoisted(() => ({
  startOAuthFlowMock: vi.fn(),
  unlinkProviderMock: vi.fn(),
}));

vi.mock("@/chat/capabilities/catalog", () => ({
  getCapabilityProvider: (capability: string) =>
    capability === "github.issues.write"
      ? {
          provider: "github",
          capabilities: ["github.issues.write"],
          configKeys: ["github.repo"],
          target: { type: "repo" as const, configKey: "github.repo" },
        }
      : undefined,
  listCapabilityProviders: () => [
    {
      provider: "github",
      capabilities: ["github.issues.write"],
      configKeys: ["github.repo"],
    },
    {
      provider: "sentry",
      capabilities: ["sentry.api"],
      configKeys: ["sentry.org", "sentry.project"],
    },
  ],
}));
vi.mock("@/chat/credentials/unlink-provider", () => ({
  unlinkProvider: unlinkProviderMock,
}));
vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig: (provider: string) =>
    provider === "github"
      ? {
          clientIdEnv: "GITHUB_CLIENT_ID",
          clientSecretEnv: "GITHUB_CLIENT_SECRET",
          authorizeEndpoint: "https://github.example.test/oauth/authorize",
          tokenEndpoint: "https://github.example.test/oauth/token",
          callbackPath: "/api/oauth/callback/github",
        }
      : undefined,
  isPluginProvider: (provider: string) =>
    provider === "github" || provider === "sentry" || provider === "notion",
}));
vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel: (provider: string) =>
    provider.charAt(0).toUpperCase() + provider.slice(1),
  startOAuthFlow: startOAuthFlowMock,
}));
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

const activeSkill: Skill = {
  name: "github",
  description: "Issue helper",
  skillPath: "/tmp/github",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"],
  usesConfig: ["github.repo"],
};

function makeChannelConfiguration() {
  let state: Record<string, unknown> | null = null;
  return createChannelConfigurationService({
    load: async () => state,
    save: async (next) => {
      state = {
        ...(state ?? {}),
        configuration: next,
      };
    },
  });
}

function makeRuntime(
  options: { failIssue?: boolean; invocationArgs?: string } = {},
) {
  const broker: CredentialBroker = {
    issue: async () => {
      if (options.failIssue) {
        throw new Error("credential broker unavailable");
      }
      return {
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: {
              Authorization: "Bearer token-1",
            },
          },
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  return new SkillCapabilityRuntime({
    broker,
    invocationArgs: options.invocationArgs ?? "--repo getsentry/junior",
    requesterId: "U123",
  });
}

describe("jr-rpc custom command", () => {
  beforeEach(() => {
    startOAuthFlowMock.mockReset();
    startOAuthFlowMock.mockImplementation(async (provider: string) => ({
      ok: false,
      error: `Provider "${provider}" does not support OAuth authorization`,
    }));
    unlinkProviderMock.mockReset();
    unlinkProviderMock.mockResolvedValue(undefined);
  });

  it("deletes both legacy and MCP-backed provider credentials", async () => {
    const userTokenStore = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc delete-token notion",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        requesterId: "U123",
        userTokenStore,
      },
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      expect(result.result.stdout).toContain("token_deleted provider=notion");
    }
    expect(unlinkProviderMock).toHaveBeenCalledWith(
      "U123",
      "notion",
      userTokenStore,
    );
  });

  it("does not handle non jr-rpc commands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("echo hi", {
      capabilityRuntime: makeRuntime(),
      activeSkill,
    });
    expect(result).toEqual({ handled: false });
  });

  it("handles valid issue-credential command", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      expect(result.result.stdout).toContain("credential_enabled");
    }
  });

  it("handles valid issue-credential command with --repo", async () => {
    const broker: CredentialBroker = {
      issue: async (input) => {
        expect(input.target).toEqual({ owner: "getsentry", repo: "junior" });
        return {
          id: "lease-1",
          provider: "github",
          capability: "github.issues.write",
          env: { GITHUB_TOKEN: "token-1" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const runtime = new SkillCapabilityRuntime({ broker, requesterId: "U123" });
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write --repo getsentry/junior",
      {
        capabilityRuntime: runtime,
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      expect(result.result.stdout).toContain("credential_enabled");
    }
  });

  it("returns usage error for missing capability", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain("requires a capability argument");
    }
  });

  it("returns usage error for unsupported jr-rpc subcommands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc credential exec --cap github.issues.write --repo a/b -- cmd",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain("Unsupported jr-rpc command");
    }
  });

  it("returns usage error for invalid --repo format", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write --repo invalid",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain(
        "--repo must be in owner/repo format",
      );
    }
  });

  it("returns structured runtime errors for credential issuance failures", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write",
      {
        capabilityRuntime: makeRuntime({ failIssue: true }),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(1);
      expect(result.result.stderr).toContain("credential broker unavailable");
    }
  });

  it("treats oauth initiation as a successful issue-credential outcome", async () => {
    startOAuthFlowMock.mockResolvedValue({
      ok: true,
      delivery: "in_context",
    });

    const runtime = new SkillCapabilityRuntime({
      broker: {
        issue: async () => {
          throw new CredentialUnavailableError(
            "github",
            "No github credentials available.",
          );
        },
      },
      invocationArgs: "--repo getsentry/junior",
      requesterId: "U123",
    });

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write",
      {
        capabilityRuntime: runtime,
        activeSkill,
        requesterId: "U123",
        userMessage: "Connect my github account",
      },
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      const payload = JSON.parse(result.result.stdout) as {
        oauth_started: boolean;
        private_delivery_sent: boolean;
      };
      expect(payload).toMatchObject({
        oauth_started: true,
        private_delivery_sent: true,
      });
    }
    expect(startOAuthFlowMock).toHaveBeenCalledWith(
      "github",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "Connect my github account",
      }),
    );
  });

  it("returns structured runtime errors when repo context is missing", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write",
      {
        capabilityRuntime: makeRuntime({ invocationArgs: "" }),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(1);
      expect(result.result.stderr).toContain("requires repository context");
    }
  });

  it("handles config set/get/list/unset commands with inferred channel configuration context", async () => {
    const configuration = makeChannelConfiguration();
    const resultSet = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config set github.repo getsentry/junior",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        channelConfiguration: configuration,
        requesterId: "U123",
      },
    );
    expect(resultSet.handled).toBe(true);
    if (resultSet.handled) {
      expect(resultSet.result.exit_code).toBe(0);
      const payload = JSON.parse(resultSet.result.stdout) as {
        ok: boolean;
        key: string;
        value: string;
      };
      expect(payload).toMatchObject({
        ok: true,
        key: "github.repo",
        value: "getsentry/junior",
      });
    }

    const resultGet = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        channelConfiguration: configuration,
      },
    );
    expect(resultGet.handled).toBe(true);
    if (resultGet.handled) {
      expect(resultGet.result.exit_code).toBe(0);
      const payload = JSON.parse(resultGet.result.stdout) as {
        ok: boolean;
        key: string;
        value: string;
      };
      expect(payload).toMatchObject({
        ok: true,
        key: "github.repo",
        value: "getsentry/junior",
      });
    }

    const resultList = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config list --prefix github.",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        channelConfiguration: configuration,
      },
    );
    expect(resultList.handled).toBe(true);
    if (resultList.handled) {
      expect(resultList.result.exit_code).toBe(0);
      const payload = JSON.parse(resultList.result.stdout) as {
        ok: boolean;
        entries: Array<{ key: string; value: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]).toMatchObject({
        key: "github.repo",
        value: "getsentry/junior",
      });
    }

    const resultUnset = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config unset github.repo",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        channelConfiguration: configuration,
      },
    );
    expect(resultUnset.handled).toBe(true);
    if (resultUnset.handled) {
      expect(resultUnset.result.exit_code).toBe(0);
      const payload = JSON.parse(resultUnset.result.stdout) as {
        ok: boolean;
        deleted: boolean;
      };
      expect(payload).toMatchObject({
        ok: true,
        deleted: true,
      });
    }
  });

  it("returns runtime error for config commands without inferred channel context", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config get github.repo",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(1);
      expect(result.result.stderr).toContain(
        "require active conversation context",
      );
    }
  });

  it("parses json values for config set --json", async () => {
    const configuration = makeChannelConfiguration();
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc config set app.flags 123 --json",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        channelConfiguration: configuration,
      },
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      const payload = JSON.parse(result.result.stdout) as { value: number };
      expect(payload.value).toEqual(123);
    }
  });

  it("returns an error when a provider has no oauth flow", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc oauth-start notion",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        requesterId: "U123",
      },
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(1);
      expect(result.result.stderr).toContain(
        'Provider "notion" does not support OAuth authorization',
      );
    }
  });
});
