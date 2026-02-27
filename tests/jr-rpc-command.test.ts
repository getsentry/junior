import { describe, expect, it } from "vitest";
import { maybeExecuteJrRpcCustomCommand } from "@/chat/capabilities/jr-rpc-command";
import { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { Skill } from "@/chat/skills";

const activeSkill: Skill = {
  name: "gh-issue",
  description: "Issue helper",
  skillPath: "/tmp/gh-issue",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"]
};

function makeRuntime(options: { failIssue?: boolean } = {}) {
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
              Authorization: "Bearer token-1"
            }
          }
        ],
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    }
  };
  return new SkillCapabilityRuntime({ broker });
}

describe("jr-rpc custom command", () => {
  it("does not handle non jr-rpc commands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("echo hi", {
      capabilityRuntime: makeRuntime(),
      activeSkill
    });
    expect(result).toEqual({ handled: false });
  });

  it("handles valid issue-credential command", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("jr-rpc issue-credential github.issues.write", {
      capabilityRuntime: makeRuntime(),
      activeSkill
    });
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
                Authorization: "Bearer token-1"
              }
            }
          ],
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      }
    };
    const runtime = new SkillCapabilityRuntime({ broker });
    const result = await maybeExecuteJrRpcCustomCommand(
      "jr-rpc issue-credential github.issues.write --repo getsentry/junior",
      {
        capabilityRuntime: runtime,
        activeSkill
      }
    );
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(0);
      expect(result.result.stdout).toContain("credential_enabled");
    }
  });

  it("returns usage error for missing capability", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("jr-rpc issue-credential", {
      capabilityRuntime: makeRuntime(),
      activeSkill
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain("requires a capability argument");
    }
  });

  it("returns usage error for unsupported jr-rpc subcommands", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("jr-rpc credential exec --cap github.issues.write --repo a/b -- cmd", {
      capabilityRuntime: makeRuntime(),
      activeSkill
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain("Unsupported jr-rpc command");
    }
  });

  it("returns usage error for invalid --repo format", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("jr-rpc issue-credential github.issues.write --repo invalid", {
      capabilityRuntime: makeRuntime(),
      activeSkill
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(2);
      expect(result.result.stderr).toContain("--repo must be in owner/repo format");
    }
  });

  it("returns structured runtime errors for credential issuance failures", async () => {
    const result = await maybeExecuteJrRpcCustomCommand("jr-rpc issue-credential github.issues.write", {
      capabilityRuntime: makeRuntime({ failIssue: true }),
      activeSkill
    });
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.result.exit_code).toBe(1);
      expect(result.result.stderr).toContain("credential broker unavailable");
    }
  });
});
