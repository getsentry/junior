import { describe, expect, it, vi } from "vitest";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

vi.mock("@/chat/plugins/registry", () => ({
  getPluginDefinition: (provider: string) =>
    provider === "github"
      ? {
          manifest: {
            name: "github",
            description: "GitHub",
            capabilities: [
              "github.issues.read",
              "github.issues.write",
              "github.contents.read",
              "github.contents.write",
              "github.pull-requests.read",
              "github.pull-requests.write",
            ],
            configKeys: ["github.repo"],
            credentials: {
              type: "github-app",
              apiDomains: ["api.github.com"],
              authTokenEnv: "GITHUB_TOKEN",
              appIdEnv: "GITHUB_APP_ID",
              privateKeyEnv: "GITHUB_APP_PRIVATE_KEY",
              installationIdEnv: "GITHUB_INSTALLATION_ID",
            },
            target: {
              type: "repo",
              configKey: "github.repo",
              commandFlags: ["--repo", "-R"],
            },
          },
        }
      : provider === "sentry"
        ? {
            manifest: {
              name: "sentry",
              description: "Sentry",
              capabilities: ["sentry.api"],
              configKeys: ["sentry.org", "sentry.project"],
              credentials: {
                type: "oauth-bearer",
                apiDomains: ["sentry.io"],
                authTokenEnv: "SENTRY_AUTH_TOKEN",
              },
            },
          }
        : undefined,
}));

import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";

const githubSkill: Skill = {
  name: "github",
  description: "Issue helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
  usesConfig: ["github.repo"],
};

const sentrySkill: Skill = {
  name: "sentry",
  description: "Sentry helper",
  skillPath: "/tmp/sentry",
  body: "instructions",
  pluginProvider: "sentry",
};

describe("skill capability runtime", () => {
  it("issues turn-scoped transforms on first enable and reuses them within the turn", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: "lease-1",
          provider: "sentry",
          env: { SENTRY_AUTH_TOKEN: "host_managed_credential" },
          headerTransforms: [
            {
              domain: "sentry.io",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: sentrySkill,
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    expect(runtime.getTurnHeaderTransforms()).toEqual([
      {
        domain: "sentry.io",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    ]);
    expect(runtime.getTurnEnv()).toEqual({
      SENTRY_AUTH_TOKEN: "host_managed_credential",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: sentrySkill,
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });

  it("reuses provider credentials within the same turn for GitHub", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: `lease-${issueCalls}`,
          provider: "github",
          env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: `Bearer token-${issueCalls}`,
              },
            },
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: githubSkill,
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: githubSkill,
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });

  it("enables GitHub credentials without extra target plumbing", async () => {
    let seenReason: string | undefined;
    const broker: CredentialBroker = {
      issue: async (input) => {
        seenReason = input.reason;
        return {
          id: "lease-1",
          provider: "github",
          env: { GITHUB_TOKEN: "ghp_host_managed_credential" },
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

    const runtime = new SkillCapabilityRuntime({
      broker,
      requesterId: "U123",
    });

    await expect(
      runtime.enableCredentialsForCommand({
        activeSkill: githubSkill,
        reason: "test:no-target",
      }),
    ).resolves.toBeUndefined();

    expect(seenReason).toBe("test:no-target");
  });
});
