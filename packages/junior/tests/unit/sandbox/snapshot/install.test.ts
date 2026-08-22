import { describe, expect, it, vi } from "vitest";
import { dependencies } from "@/chat/sandbox/snapshot/install";
import type {
  SandboxCommandInput,
  SandboxSession,
} from "@/chat/sandbox/workspace";


/** Test-only bridge for intentionally incomplete doubles. */
function asTestDouble<T>(value: unknown): T {
  return value as T;
}

function session(
  run: (
    input: SandboxCommandInput,
  ) => Promise<{ exitCode: number; stderr: string; stdout: string }>,
): SandboxSession {
  return asTestDouble<SandboxSession>({ runCommand: vi.fn(run) });
}

function script(input: SandboxCommandInput): string {
  return input.args?.[1] ?? "";
}

describe("snapshot dependency installation", () => {
  it("installs repository packages before packages that use them", async () => {
    const sandbox = session(async () => ({
      exitCode: 0,
      stderr: "",
      stdout: "",
    }));

    await dependencies(sandbox, [
      { type: "system", package: "spal-release" },
      { type: "system", package: "ripgrep" },
    ]);

    const calls = vi.mocked(sandbox.runCommand).mock.calls;
    expect(calls.map(([input]) => script(input))).toEqual([
      expect.stringContaining("'dnf' 'install' '-y' 'spal-release'"),
      expect.stringContaining("'dnf' 'install' '-y' 'ripgrep'"),
    ]);
    expect(calls.every(([input]) => input.sudo)).toBe(true);
  });

  it("rejects downloaded packages whose checksum does not match", async () => {
    const sandbox = session(async (input) => {
      if (script(input).includes("'sha256sum'")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `${"b".repeat(64)}  /tmp/tool.rpm`,
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await expect(
      dependencies(sandbox, [
        {
          type: "system",
          url: "https://example.com/tool.rpm",
          sha256: "a".repeat(64),
        },
      ]),
    ).rejects.toThrow("checksum mismatch");

    const calls = vi.mocked(sandbox.runCommand).mock.calls;
    expect(
      calls.some(([input]) =>
        script(input).includes("'dnf' 'install' '-y' '/tmp/"),
      ),
    ).toBe(false);
  });

  it("adds the GitHub CLI repository when the base image lacks gh", async () => {
    const sandbox = session(async (input) => {
      const command = script(input);
      if (
        command.includes("'dnf' 'install' '-y' 'gh'") &&
        !command.includes("'--repo' 'gh-cli'")
      ) {
        return { exitCode: 1, stderr: "package not found", stdout: "" };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    });

    await dependencies(sandbox, [{ type: "system", package: "gh" }]);

    const scripts = vi
      .mocked(sandbox.runCommand)
      .mock.calls.map(([input]) => script(input));
    expect(scripts).toEqual([
      expect.stringContaining("'dnf' 'install' '-y' 'gh'"),
      expect.stringContaining(
        "'dnf' 'config-manager' 'addrepo' '--from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo'",
      ),
      expect.stringContaining("'dnf' 'install' '-y' 'gh' '--repo' 'gh-cli'"),
    ]);
  });
});
