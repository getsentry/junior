import { describe, expect, it, vi } from "vitest";
import { executeJrRpcCommand, mapJrRpcToolInputToCommand } from "@/chat/capabilities/jr-rpc";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { Skill } from "@/chat/skills";

const activeSkill: Skill = {
  name: "gh-issue",
  description: "Issue helper",
  skillPath: "/tmp/gh-issue",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"]
};

describe("jrRpc command mapping", () => {
  it("maps issue tool input with default format", () => {
    const command = mapJrRpcToolInputToCommand({
      action: "issue",
      capability: "github.issues.read",
      repo: "getsentry/junior"
    });

    expect(command).toEqual({
      kind: "issue",
      capability: "github.issues.read",
      repo: "getsentry/junior",
      format: "token"
    });
  });

  it("maps exec tool input", () => {
    const command = mapJrRpcToolInputToCommand({
      action: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      command: "node script.mjs create"
    });

    expect(command).toEqual({
      kind: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      execCommand: "node script.mjs create"
    });
  });

  it("rejects exec input with empty command", () => {
    expect(() =>
      mapJrRpcToolInputToCommand({
        action: "exec",
        capability: "github.issues.write",
        repo: "getsentry/junior",
        command: "   "
      })
    ).toThrow("jrRpc exec requires a non-empty command");
  });
});

describe("jrRpc command execution", () => {
  it("issues credentials and returns metadata for issue mode without raw token", async () => {
    const runtime = {
      issueCapabilityLease: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))
    } as unknown as SkillCapabilityRuntime;

    const command = mapJrRpcToolInputToCommand({
      action: "issue",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      format: "token"
    });

    const result = await executeJrRpcCommand({
      command,
      activeSkill,
      capabilityRuntime: runtime,
      executeBashWithEnv: async () => ({ ok: false })
    });

    expect(result).toMatchObject({ ok: true, command: "jrRpc issue" });
    expect((result as { stdout: string }).stdout).toContain("issued provider=github");
    expect((result as { stdout: string }).stdout).toContain("envKeys=GITHUB_TOKEN");
    expect((result as { stdout: string }).stdout).not.toContain("token-1");
  });

  it("issues credentials and executes nested command for exec mode", async () => {
    const runtime = {
      issueCapabilityLease: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))
    } as unknown as SkillCapabilityRuntime;

    const executeBashWithEnv = vi.fn(async () => ({ ok: true, exit_code: 0 }));
    const command = mapJrRpcToolInputToCommand({
      action: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      command: "node script.mjs create"
    });

    const result = await executeJrRpcCommand({
      command,
      activeSkill,
      capabilityRuntime: runtime,
      executeBashWithEnv
    });

    expect(executeBashWithEnv).toHaveBeenCalledWith("node script.mjs create", { GITHUB_TOKEN: "token-1" });
    expect(result).toEqual({ ok: true, exit_code: 0 });
  });

  it("adds actionable context for credential issuance failures", async () => {
    const runtime = {
      issueCapabilityLease: vi.fn(async () => {
        throw new Error("error:1E08010C:DECODER routines::unsupported");
      })
    } as unknown as SkillCapabilityRuntime;

    const command = mapJrRpcToolInputToCommand({
      action: "issue",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      format: "token"
    });

    await expect(
      executeJrRpcCommand({
        command,
        activeSkill,
        capabilityRuntime: runtime,
        executeBashWithEnv: async () => ({ ok: false })
      })
    ).rejects.toThrow("jrRpc issue failed (capability=github.issues.write, repo=getsentry/junior)");

    await expect(
      executeJrRpcCommand({
        command,
        activeSkill,
        capabilityRuntime: runtime,
        executeBashWithEnv: async () => ({ ok: false })
      })
    ).rejects.toThrow("Host signer could not decode GITHUB_APP_PRIVATE_KEY");
  });

  it("adds context when nested exec command fails after credential issuance", async () => {
    const runtime = {
      issueCapabilityLease: vi.fn(async () => ({
        id: "lease-1",
        provider: "github",
        capability: "github.issues.write",
        env: { GITHUB_TOKEN: "token-1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))
    } as unknown as SkillCapabilityRuntime;

    const command = mapJrRpcToolInputToCommand({
      action: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      command: "node script.mjs create"
    });

    await expect(
      executeJrRpcCommand({
        command,
        activeSkill,
        capabilityRuntime: runtime,
        executeBashWithEnv: async () => {
          throw new Error("script failed with exit code 2");
        }
      })
    ).rejects.toThrow(
      "jrRpc exec failed while running nested command (capability=github.issues.write, repo=getsentry/junior): script failed with exit code 2"
    );
  });
});
