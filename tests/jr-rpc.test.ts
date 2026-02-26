import { describe, expect, it, vi } from "vitest";
import { executeJrRpcCommand, parseJrRpcCommand } from "@/chat/capabilities/jr-rpc";
import type { SkillCapabilityRuntime } from "@/chat/capabilities/runtime";
import type { Skill } from "@/chat/skills";

const activeSkill: Skill = {
  name: "gh-issue",
  description: "Issue helper",
  skillPath: "/tmp/gh-issue",
  body: "instructions",
  requiresCapabilities: ["github.issues.write"]
};

describe("jr-rpc command parsing", () => {
  it("parses credential issue command", () => {
    const command = parseJrRpcCommand("jr-rpc credential issue --cap github.issues.write --repo getsentry/junior");
    expect(command).toEqual({
      kind: "issue",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      format: "token"
    });
  });

  it("parses credential exec command", () => {
    const command = parseJrRpcCommand(
      "jr-rpc credential exec --cap github.issues.write --repo getsentry/junior -- node script.mjs create"
    );
    expect(command).toEqual({
      kind: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      execCommand: "node script.mjs create"
    });
  });

  it("preserves quoted exec command tail after --", () => {
    const command = parseJrRpcCommand(
      "jr-rpc credential exec --cap github.issues.write --repo getsentry/junior -- bash -lc 'echo \"$GITHUB_TOKEN\" && echo done'"
    );
    expect(command).toEqual({
      kind: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      execCommand: "bash -lc 'echo \"$GITHUB_TOKEN\" && echo done'"
    });
  });

  it("parses exec when delimiter has variable whitespace", () => {
    const command = parseJrRpcCommand(
      "jr-rpc credential exec --cap github.issues.write --repo getsentry/junior   --   node script.mjs create"
    );
    expect(command).toEqual({
      kind: "exec",
      capability: "github.issues.write",
      repo: "getsentry/junior",
      execCommand: "node script.mjs create"
    });
  });
});

describe("jr-rpc command execution", () => {
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

    const command = parseJrRpcCommand(
      "jr-rpc credential issue --cap github.issues.write --repo getsentry/junior --format token"
    );
    expect(command).not.toBeNull();

    const result = await executeJrRpcCommand({
      command: command!,
      activeSkill,
      capabilityRuntime: runtime,
      executeBashWithEnv: async () => ({ ok: false })
    });

    expect(result).toMatchObject({ ok: true });
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
    const command = parseJrRpcCommand(
      "jr-rpc credential exec --cap github.issues.write --repo getsentry/junior -- node script.mjs create"
    );
    expect(command).not.toBeNull();

    const result = await executeJrRpcCommand({
      command: command!,
      activeSkill,
      capabilityRuntime: runtime,
      executeBashWithEnv
    });

    expect(executeBashWithEnv).toHaveBeenCalledWith("node script.mjs create", { GITHUB_TOKEN: "token-1" });
    expect(result).toEqual({ ok: true, exit_code: 0 });
  });
});
