import { describe, expect, it } from "vitest";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

const fakeSkill: Skill = {
  name: "gh-issue",
  description: "Issue helper",
  skillPath: "/tmp/gh-issue",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"]
};

describe("skill capability runtime", () => {
  it("returns undefined when no active skill capabilities are required", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      }
    };

    const runtime = new SkillCapabilityRuntime({ broker });
    await expect(runtime.resolveBashEnv({ command: "echo hi", activeSkill: null })).resolves.toBeUndefined();
  });

  it("issues env credentials for required capabilities", async () => {
    const broker: CredentialBroker = {
      issue: async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      invocationArgs: "--repo getsentry/junior"
    });

    await expect(runtime.resolveBashEnv({ command: "node script.mjs", activeSkill: fakeSkill })).resolves.toEqual({
      GITHUB_TOKEN: "token-1"
    });
  });

  it("allows explicit lease issuance without active skill", async () => {
    const broker: CredentialBroker = {
      issue: async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })
    };

    const runtime = new SkillCapabilityRuntime({ broker });

    await expect(
      runtime.issueCapabilityLease({
        activeSkill: null,
        capability: "github.issues.write",
        repoRef: "getsentry/junior",
        reason: "test:explicit"
      })
    ).resolves.toMatchObject({
      provider: "github",
      env: {
        GITHUB_TOKEN: "token-1"
      }
    });
  });
});
