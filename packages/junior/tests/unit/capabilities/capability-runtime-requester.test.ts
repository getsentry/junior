import { describe, expect, it, vi } from "vitest";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

vi.mock("@/chat/capabilities/catalog", () => ({
  getCapabilityProvider: (capability: string) =>
    capability === "sentry.api"
      ? {
          provider: "sentry",
          capabilities: ["sentry.api"],
          configKeys: [],
        }
      : undefined,
}));

import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";

const fakeSkill: Skill = {
  name: "sentry",
  description: "Sentry helper",
  skillPath: "/tmp/sentry",
  body: "instructions",
  requiresCapabilities: ["sentry.api"],
};

describe("skill capability runtime requester binding", () => {
  it("requires requester context for issue-credential in runtime mode", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      },
    };

    const runtime = new SkillCapabilityRuntime({ broker });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "sentry.api",
        reason: "test:missing-requester",
      }),
    ).rejects.toThrow("requires requester context");
  });

  it("allows credential issuance with requester context and reuses within the turn", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: "lease-1",
          provider: "sentry",
          capability: "sentry.api",
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
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "sentry.api",
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "sentry.api",
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });
});
