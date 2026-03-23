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
}));
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

const fakeSkill: Skill = {
  name: "github",
  description: "Issue helper",
  skillPath: "/tmp/github",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"],
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
      invocationArgs: "--repo getsentry/junior",
      requesterId: "U123",
    });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:first",
      }),
    ).resolves.toMatchObject({ reused: false });
    expect(runtime.getTurnHeaderTransforms()).toEqual([
      {
        domain: "api.github.com",
        headers: {
          Authorization: "Bearer token-1",
        },
      },
    ]);
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:second",
      }),
    ).resolves.toMatchObject({ reused: true });
    expect(issueCalls).toBe(1);
  });

  it("does not reuse cached credentials across different repository scopes", async () => {
    let issueCalls = 0;
    const broker: CredentialBroker = {
      issue: async () => {
        issueCalls += 1;
        return {
          id: `lease-${issueCalls}`,
          provider: "github",
          capability: "github.issues.write",
          env: { GITHUB_TOKEN: `token-${issueCalls}` },
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
      invocationArgs: "--repo getsentry/junior",
      requesterId: "U123",
    });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        repoRef: "getsentry/junior",
        reason: "test:repo-one",
      }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        repoRef: "getsentry/sentry",
        reason: "test:repo-two",
      }),
    ).resolves.toMatchObject({ reused: false });
    expect(issueCalls).toBe(2);
  });

  it("allows explicit lease issuance without active skill", async () => {
    const broker: CredentialBroker = {
      issue: async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      invocationArgs: "--repo getsentry/junior",
      requesterId: "U123",
    });

    await expect(
      runtime.issueCapabilityLease({
        activeSkill: null,
        capability: "github.issues.write",
        repoRef: "getsentry/junior",
        reason: "test:explicit",
      }),
    ).resolves.toMatchObject({
      provider: "github",
      env: {
        GITHUB_TOKEN: "token-1",
      },
    });
  });

  it("rejects unsupported capabilities for issue-credential", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      },
    };

    const runtime = new SkillCapabilityRuntime({ broker, requesterId: "U123" });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "app.test.read",
        reason: "test:unsupported-provider",
      }),
    ).rejects.toThrow("Unsupported capability");
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
      invocationArgs: "--repo getsentry/ignored",
      requesterId: "U123",
    });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        repoRef: "getsentry/junior",
        reason: "test:repo-ref",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(seenTarget).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("requires repo context for github capabilities", async () => {
    const broker: CredentialBroker = {
      issue: async () => {
        throw new Error("should not be called");
      },
    };

    const runtime = new SkillCapabilityRuntime({
      broker,
      invocationArgs: "",
      requesterId: "U123",
    });
    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: fakeSkill,
        capability: "github.issues.write",
        reason: "test:missing-repo",
      }),
    ).rejects.toThrow("requires repository context");
  });

  it("falls back to configured github.repo when invocation args do not include --repo", async () => {
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
      invocationArgs: "",
      requesterId: "U123",
      resolveConfiguration: async (key) =>
        key === "github.repo" ? "getsentry/junior" : undefined,
    });

    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: {
          ...fakeSkill,
          usesConfig: ["github.repo"],
        },
        capability: "github.issues.write",
        reason: "test:configured-repo",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(seenTarget).toEqual({ owner: "getsentry", repo: "junior" });
  });

  it("still uses explicit repoRef when config value exists", async () => {
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
      invocationArgs: "",
      requesterId: "U123",
      resolveConfiguration: async () => "getsentry/junior",
    });

    await expect(
      runtime.enableCapabilityForTurn({
        activeSkill: {
          ...fakeSkill,
          usesConfig: ["github.repo"],
        },
        capability: "github.issues.write",
        repoRef: "getsentry/sentry",
        reason: "test:explicit-overrides-config",
      }),
    ).resolves.toMatchObject({ reused: false });

    expect(seenTarget).toEqual({ owner: "getsentry", repo: "sentry" });
  });
});
