import { describe, expect, it, vi } from "vitest";

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
    { provider: "notion", capabilities: ["notion.api.read"], configKeys: [] },
  ],
}));
const oauthStateStore = new Map<string, unknown>();
const deliveredMessages: Array<{
  channel: string;
  user: string;
  text: string;
}> = [];
vi.mock("@/chat/state", () => ({
  getStateAdapter: () => ({
    get: async <T>(key: string): Promise<T | null> =>
      (oauthStateStore.get(key) as T) ?? null,
    set: async (key: string, value: unknown) => {
      oauthStateStore.set(key, value);
    },
    delete: async (key: string) => {
      oauthStateStore.delete(key);
    },
  }),
}));
vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig: (provider: string) => {
    if (provider === "notion") {
      return {
        clientIdEnv: "NOTION_CLIENT_ID",
        clientSecretEnv: "NOTION_CLIENT_SECRET",
        authorizeEndpoint: "https://api.notion.com/v1/oauth/authorize",
        tokenEndpoint: "https://api.notion.com/v1/oauth/token",
        authorizeParams: { owner: "user" },
        callbackPath: "/api/oauth/callback/notion",
      };
    }
    if (provider === "sentry") {
      return {
        clientIdEnv: "SENTRY_CLIENT_ID",
        clientSecretEnv: "SENTRY_CLIENT_SECRET",
        authorizeEndpoint: "https://sentry.io/oauth/authorize/",
        tokenEndpoint: "https://sentry.io/oauth/token/",
        scope: "event:read org:read project:read",
        callbackPath: "/api/oauth/callback/sentry",
      };
    }
    return undefined;
  },
}));
vi.mock("@/chat/slack-actions/client", () => ({
  getSlackClient: () => ({
    chat: {
      postMessage: vi.fn(
        async ({ channel, text }: { channel: string; text: string }) => {
          deliveredMessages.push({ channel, user: channel, text });
        },
      ),
      postEphemeral: vi.fn(
        async ({
          channel,
          user,
          text,
        }: {
          channel: string;
          user: string;
          text: string;
        }) => {
          deliveredMessages.push({ channel, user, text });
        },
      ),
    },
    conversations: {
      open: vi.fn(async ({ users }: { users: string }) => ({
        channel: { id: `D-${users}` },
      })),
    },
  }),
  isDmChannel: (channelId: string) => channelId.startsWith("D"),
}));
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import { createChannelConfigurationService } from "@/chat/configuration/service";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { StoredTokens } from "@/chat/credentials/user-token-store";
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

  it("treats no-expiry oauth tokens as already connected", async () => {
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc oauth-start notion",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        requesterId: "U123",
        userTokenStore: {
          get: async (): Promise<StoredTokens> => ({
            accessToken: "notion-token",
            refreshToken: "notion-refresh-token",
          }),
          set: async () => {},
          delete: async () => {},
        },
      },
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      const payload = JSON.parse(result.result.stdout) as {
        already_connected: boolean;
        provider: string;
      };
      expect(payload).toMatchObject({
        already_connected: true,
        provider: "notion",
      });
    }
  });

  it("includes provider authorize params and omits scope when starting notion oauth", async () => {
    deliveredMessages.length = 0;
    oauthStateStore.clear();
    process.env.NOTION_CLIENT_ID = "notion-client-id";
    process.env.JUNIOR_BASE_URL = "https://example.com";

    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc oauth-start notion",
      {
        capabilityRuntime: makeRuntime(),
        activeSkill,
        requesterId: "U123",
        channelId: "C123",
        threadTs: "123.456",
        userTokenStore: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
        },
      },
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      const payload = JSON.parse(result.result.stdout) as {
        private_delivery_sent: boolean;
      };
      expect(payload.private_delivery_sent).toBe(true);
    }

    expect(deliveredMessages).toHaveLength(1);
    const linkText = deliveredMessages[0]?.text ?? "";
    const match = linkText.match(/<([^|>]+)\|/);
    expect(match?.[1]).toBeDefined();
    const url = new URL(match![1]);
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("client_id")).toBe("notion-client-id");
  });
});
