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
  it("issues turn-scoped transforms on first enable and reuses them within the turn", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: "lease-1",
          provider: "github",
          capability: "github.issues.write",
          env: { GITHUB_TOKEN: "token-1" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1"
              }
            }
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      }
    };

    const runtime = new SkillCapabilityRuntime({ broker, invocationArgs: "--repo getsentry/junior" });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:first"
      })
    ).resolves.toMatchObject({ reused: false });
    expect(runtime.getTurnHeaderTransforms()).toEqual([
      {
        domain: "api.github.com",
        headers: {
          Authorization: "Bearer token-1"
        }
      }
    ]);
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:second"
      })
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
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

    const runtime = new SkillCapabilityRuntime({ broker, invocationArgs: "--repo getsentry/junior" });

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

  it("rejects unsupported provider prefixes for issue-credential", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      }
    };

    const runtime = new SkillCapabilityRuntime({ broker });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "app.test.read",
        reason: "test:unsupported-provider"
      })
    ).rejects.toThrow("Unsupported capability provider");
  });

  it("forwards explicit repoRef through enableCapabilityForTurn", async () => {
    let seenTarget: { owner?: string; repo?: string } | undefined;
    const broker: CredentialBroker = {
      issue: async (input) => {
        seenTarget = input.target;
        return {
          id: "lease-1",
          provider: "github",
          capability: "github.issues.write",
          env: { GITHUB_TOKEN: "token-1" },
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1"
              }
            }
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      }
    };

    const runtime = new SkillCapabilityRuntime({ broker, invocationArgs: "--repo getsentry/ignored" });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        repoRef: "getsentry/junior",
        reason: "test:repo-ref"
      })
    ).resolves.toMatchObject({ reused: false });

    expect(seenTarget).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("requires repo context for github capabilities", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      }
    };

    const runtime = new SkillCapabilityRuntime({ broker, invocationArgs: "" });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:missing-repo"
      })
    ).rejects.toThrow("requires repository context");
  });
});
