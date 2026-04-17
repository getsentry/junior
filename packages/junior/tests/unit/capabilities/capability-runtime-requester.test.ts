import { describe, expect, it, vi } from "vitest";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

vi.mock("@/chat/plugins/registry", () => ({
  getPluginDefinition: (provider: string) =>
    provider === "sentry"
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

const sentrySkill: Skill = {
  name: "sentry",
  description: "Sentry helper",
  skillPath: "/tmp/sentry",
  body: "instructions",
  pluginProvider: "sentry",
};

describe("skill capability runtime requester binding", () => {
  it("requires requester context before enabling provider credentials", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      },
    };

    const runtime = new SkillCapabilityRuntime({ broker });
    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: sentrySkill,
        reason: "test:missing-requester",
      }),
    ).rejects.toThrow("requires requester context");
  });

  it("reuses a provider lease within the same turn", async () => {
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

    const runtime = new SkillCapabilityRuntime({ broker, requesterId: "U123" });
    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: sentrySkill,
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      runtime.enableCredentialsForTurn({
        activeSkill: sentrySkill,
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });
});
