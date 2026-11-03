import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENTS_REMOVAL_NOTICE,
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
  readRepositoryInstructions,
  renderAgentsInstructions,
} from "@/chat/repository-instructions";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type {
  SandboxCommandInput,
  SandboxCommandResult,
} from "@/chat/sandbox/workspace";

const hostRoots: string[] = [];

afterEach(() => {
  for (const root of hostRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

/**
 * A sandbox workspace root in a host temp directory. Commands run on the host
 * with the temp directory as their cwd, so the read runs its real script.
 */
class HostSandbox {
  commandCount = 0;
  private readonly root = fs.mkdtempSync(
    path.join(os.tmpdir(), "junior-repository-instructions-"),
  );

  constructor() {
    hostRoots.push(this.root);
  }

  directory(sandboxPath: string): this {
    fs.mkdirSync(this.hostPath(sandboxPath), { recursive: true });
    return this;
  }

  file(sandboxPath: string, content: string): this {
    const hostPath = this.hostPath(sandboxPath);
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.writeFileSync(hostPath, content);
    return this;
  }

  /** Link `sandboxPath` to `target`, which is relative to the link. */
  symlink(sandboxPath: string, target: string): this {
    const hostPath = this.hostPath(sandboxPath);
    fs.mkdirSync(path.dirname(hostPath), { recursive: true });
    fs.symlinkSync(target, hostPath);
    return this;
  }

  async read(directories?: string[]) {
    return await readRepositoryInstructions({
      ...(directories ? { directories } : undefined),
      runCommand: async (input) => this.runCommand(input),
    });
  }

  private runCommand(input: SandboxCommandInput): SandboxCommandResult {
    this.commandCount += 1;
    if (input.cwd !== SANDBOX_WORKSPACE_ROOT) {
      throw new Error(`unexpected command cwd: ${input.cwd}`);
    }
    const result = spawnSync(input.cmd, input.args ?? [], {
      cwd: this.root,
      encoding: "utf8",
    });
    return {
      exitCode: result.status ?? 1,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  private hostPath(sandboxPath: string): string {
    return path.join(
      this.root,
      path.posix.relative(SANDBOX_WORKSPACE_ROOT, sandboxPath),
    );
  }
}

describe("repository instructions", () => {
  it("renders Codex-compatible initial, replacement, and removal messages", () => {
    expect(
      renderAgentsInstructions({
        directory: "/vercel/sandbox/repo",
        text: "Use pnpm.",
      }),
    ).toBe(
      "# AGENTS.md instructions for /vercel/sandbox/repo\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>",
    );
    expect(
      buildAgentsInstructionsMessage({
        directory: "/vercel/sandbox/repo",
        text: `${AGENTS_REPLACEMENT_NOTICE}\n\nUse pnpm.`,
        timestamp: 1,
      }),
    ).toMatchObject({ role: "user", timestamp: 1 });
    expect(AGENTS_REMOVAL_NOTICE).toBe(
      "The previously provided AGENTS.md instructions no longer apply.",
    );
  });

  it("loads AGENTS.md files from the Git root through the selected cwd", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repo")
      .directory("/vercel/sandbox/repo/.git")
      .directory("/vercel/sandbox/repo/packages")
      .directory("/vercel/sandbox/repo/packages/api")
      .file("/vercel/sandbox/repo/AGENTS.md", "root rules")
      .file("/vercel/sandbox/repo/packages/api/AGENTS.md", "api rules");

    const { instructions } = await sandbox.read([
      "/vercel/sandbox/repo/packages/api",
    ]);

    expect(instructions).toMatchObject({
      directory: "/vercel/sandbox/repo/packages/api",
      text: [
        "## /vercel/sandbox/repo",
        "",
        "root rules",
        "",
        "## /vercel/sandbox/repo/packages/api",
        "",
        "api rules",
      ].join("\n"),
      sources: [
        { path: "/vercel/sandbox/repo/AGENTS.md" },
        { path: "/vercel/sandbox/repo/packages/api/AGENTS.md" },
      ],
    });
  });

  it("loads AGENTS.md from each selected repository directory", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/sentry")
      .directory("/vercel/sandbox/repos/sentry/.git")
      .directory("/vercel/sandbox/repos/relay")
      .directory("/vercel/sandbox/repos/relay/.git")
      .file("/vercel/sandbox/repos/sentry/AGENTS.md", "sentry rules")
      .file("/vercel/sandbox/repos/relay/AGENTS.md", "relay rules");

    const { instructions } = await sandbox.read([
      "/vercel/sandbox/repos/sentry",
      "/vercel/sandbox/repos/relay",
    ]);

    expect(instructions).toMatchObject({
      text: [
        "## /vercel/sandbox/repos/relay",
        "",
        "relay rules",
        "",
        "## /vercel/sandbox/repos/sentry",
        "",
        "sentry rules",
      ].join("\n"),
      sources: [
        { path: "/vercel/sandbox/repos/relay/AGENTS.md" },
        { path: "/vercel/sandbox/repos/sentry/AGENTS.md" },
      ],
    });
    expect(instructions?.directory).toBeUndefined();
    expect(sandbox.commandCount).toBe(1);
  });

  it("lists model-invocable repository skills after AGENTS.md", async () => {
    const skill = (name: string, extra = "") =>
      `---\nname: ${name}\ndescription: >-\n  Use for ${name}\n  work.\n${extra}---\n\nBody.`;
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/sdk")
      .directory("/vercel/sandbox/repos/sdk/.git")
      .directory("/vercel/sandbox/repos/sdk/.agents/skills")
      .directory("/vercel/sandbox/repos/sdk/.agents/skills/write-tests")
      .directory("/vercel/sandbox/repos/sdk/.agents/skills/release")
      .directory("/vercel/sandbox/repos/sdk/.agents/skills/broken")
      .directory("/vercel/sandbox/repos/sdk/.claude/skills")
      .directory("/vercel/sandbox/repos/sdk/.claude/skills/write-tests")
      .directory("/vercel/sandbox/repos/sdk/.claude/skills/add-bundle")
      .file("/vercel/sandbox/repos/sdk/AGENTS.md", "sdk rules")
      .file("/vercel/sandbox/repos/sdk/.agents/skills/README.md", "index")
      .file(
        "/vercel/sandbox/repos/sdk/.agents/skills/write-tests/SKILL.md",
        skill("write-tests"),
      )
      .file(
        "/vercel/sandbox/repos/sdk/.agents/skills/release/SKILL.md",
        skill("release", "disable-model-invocation: true\n"),
      )
      .file(
        "/vercel/sandbox/repos/sdk/.agents/skills/broken/SKILL.md",
        "no frontmatter",
      )
      .file(
        "/vercel/sandbox/repos/sdk/.claude/skills/write-tests/SKILL.md",
        skill("write-tests").replace("Use for", "Shadowed"),
      )
      .file(
        "/vercel/sandbox/repos/sdk/.claude/skills/add-bundle/SKILL.md",
        skill("add-bundle"),
      );

    const { instructions } = await sandbox.read(["/vercel/sandbox/repos/sdk"]);

    expect(instructions?.skills).toEqual([
      {
        description: "Use for add-bundle work.",
        name: "add-bundle",
        path: "/vercel/sandbox/repos/sdk/.claude/skills/add-bundle/SKILL.md",
      },
      {
        description: "Use for write-tests work.",
        name: "write-tests",
        path: "/vercel/sandbox/repos/sdk/.agents/skills/write-tests/SKILL.md",
      },
    ]);
    expect(instructions?.text).toMatch(/^sdk rules\n\n## Repository skills\n/);
    expect(instructions?.text).toContain(
      "- `write-tests` (`/vercel/sandbox/repos/sdk/.agents/skills/write-tests/SKILL.md`): Use for write-tests work.",
    );
  });

  it("lists repository skills when the repository has no AGENTS.md", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repo")
      .directory("/vercel/sandbox/repo/.git")
      .directory("/vercel/sandbox/repo/.agents/skills")
      .directory("/vercel/sandbox/repo/.agents/skills/e2e")
      .file(
        "/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md",
        "---\nname: e2e\ndescription: Run e2e tests.\n---\n\nBody.",
      );

    const { instructions } = await sandbox.read(["/vercel/sandbox/repo"]);

    expect(instructions?.sources).toEqual([]);
    expect(instructions?.text).toMatch(/^## Repository skills\n/);
  });

  it("gives repository skills only the budget left after AGENTS.md", async () => {
    const entry =
      "- `e2e` (`/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md`): Run e2e tests.";
    const agentsBytesThatFit = 32 * 1024 - Buffer.byteLength(`${entry}\n`);
    const read = async (agentsBytes: number) =>
      await new HostSandbox()
        .directory("/vercel/sandbox/repo/.git")
        .file("/vercel/sandbox/repo/AGENTS.md", "a".repeat(agentsBytes))
        .file(
          "/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md",
          "---\nname: e2e\ndescription: Run e2e tests.\n---\n\nBody.",
        )
        .read(["/vercel/sandbox/repo"]);

    const fits = await read(agentsBytesThatFit);
    const over = await read(agentsBytesThatFit + 1);

    expect(fits.instructions?.text).toContain(entry);
    expect(over.instructions?.skills).toBeUndefined();
    expect(over.instructions?.text).not.toContain("Repository skills");
  });

  it("keeps every AGENTS.md ahead of repository skills from earlier repositories", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/alpha")
      .directory("/vercel/sandbox/repos/alpha/.git")
      .directory("/vercel/sandbox/repos/alpha/.agents/skills")
      .directory("/vercel/sandbox/repos/alpha/.agents/skills/big")
      .file(
        "/vercel/sandbox/repos/alpha/.agents/skills/big/SKILL.md",
        `---\nname: big\ndescription: ${"x".repeat(1000)}\n---\n\nBody.`,
      )
      .directory("/vercel/sandbox/repos/beta")
      .directory("/vercel/sandbox/repos/beta/.git")
      .file(
        "/vercel/sandbox/repos/beta/AGENTS.md",
        "b".repeat(32 * 1024 - 500),
      );

    const { instructions } = await sandbox.read([
      "/vercel/sandbox/repos/alpha",
      "/vercel/sandbox/repos/beta",
    ]);

    expect(instructions?.sources[0]?.content.length).toBe(32 * 1024 - 500);
    expect(instructions?.skills).toBeUndefined();
  });

  it("shares one AGENTS.md byte budget across selected repositories", async () => {
    const first = "a".repeat(30 * 1024);
    const second = "b".repeat(8 * 1024);
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/alpha")
      .directory("/vercel/sandbox/repos/alpha/.git")
      .directory("/vercel/sandbox/repos/beta")
      .directory("/vercel/sandbox/repos/beta/.git")
      .file("/vercel/sandbox/repos/alpha/AGENTS.md", first)
      .file("/vercel/sandbox/repos/beta/AGENTS.md", second);

    const { instructions } = await sandbox.read([
      "/vercel/sandbox/repos/alpha",
      "/vercel/sandbox/repos/beta",
    ]);

    expect(instructions?.sources).toHaveLength(2);
    expect(instructions?.sources[0]?.content).toBe(first);
    expect(instructions?.sources[1]?.content.length).toBe(2 * 1024);
    expect(Buffer.byteLength(instructions!.text, "utf8")).toBeLessThanOrEqual(
      32 * 1024 + 256,
    );
  });

  it("cuts AGENTS.md at the budget and lists skills with a large SKILL.md", async () => {
    const agents = `${"a".repeat(32 * 1024 - 1)}é${"b".repeat(1024)}`;
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox/repos/rules/.git")
      .file("/vercel/sandbox/repos/rules/AGENTS.md", agents)
      .directory("/vercel/sandbox/repos/tools/.git")
      .file(
        "/vercel/sandbox/repos/tools/.agents/skills/e2e/SKILL.md",
        `---\nname: e2e\ndescription: Run e2e tests.\n---\n\n${"x".repeat(40 * 1024)}`,
      );

    const rules = await sandbox.read(["/vercel/sandbox/repos/rules"]);
    const tools = await sandbox.read(["/vercel/sandbox/repos/tools"]);

    // The cut splits the two-byte character, as a full read would.
    expect(rules.instructions?.sources[0]?.content).toBe(
      Buffer.from(agents, "utf8")
        .subarray(0, 32 * 1024)
        .toString("utf8"),
    );
    expect(tools.instructions?.skills).toEqual([
      {
        description: "Run e2e tests.",
        name: "e2e",
        path: "/vercel/sandbox/repos/tools/.agents/skills/e2e/SKILL.md",
      },
    ]);
  });

  it("follows symlinked AGENTS.md files and skill roots", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox/repo/.git")
      .file("/vercel/sandbox/repo/docs/agents.md", "linked rules")
      .symlink("/vercel/sandbox/repo/AGENTS.md", "docs/agents.md")
      .file(
        "/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md",
        "---\nname: e2e\ndescription: Run e2e tests.\n---\n\nBody.",
      )
      .symlink("/vercel/sandbox/repo/.agents/skills/gone", "missing")
      .symlink("/vercel/sandbox/repo/.claude/skills", "../.agents/skills");

    const { instructions } = await sandbox.read(["/vercel/sandbox/repo"]);

    expect(instructions?.sources).toEqual([
      { content: "linked rules", path: "/vercel/sandbox/repo/AGENTS.md" },
    ]);
    expect(instructions?.skills).toEqual([
      {
        description: "Run e2e tests.",
        name: "e2e",
        path: "/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md",
      },
    ]);
  });

  it("skips skill entries whose names hold a line break", async () => {
    const sandbox = new HostSandbox()
      .directory("/vercel/sandbox/repo/.git")
      .directory("/vercel/sandbox/repo/.agents/skills/bad\nname")
      .file(
        "/vercel/sandbox/repo/.agents/skills/e2e/SKILL.md",
        "---\nname: e2e\ndescription: Run e2e tests.\n---\n\nBody.",
      );

    const { instructions } = await sandbox.read(["/vercel/sandbox/repo"]);

    expect(instructions?.skills?.map((skill) => skill.name)).toEqual(["e2e"]);
  });

  it("reads every Git worktree under repos/ with one command", async () => {
    const sandbox = new HostSandbox()
      .file("/vercel/sandbox/repos/repo/.git", "gitdir: elsewhere")
      .file("/vercel/sandbox/repos/repo/AGENTS.md", "repo rules")
      .directory("/vercel/sandbox/repos/other/.git")
      .file("/vercel/sandbox/repos/other/AGENTS.md", "other rules")
      .file("/vercel/sandbox/repos/plain/AGENTS.md", "not a worktree")
      .file("/vercel/sandbox/repos/notes.txt", "not a directory");

    const { directories, instructions } = await sandbox.read();

    expect(directories).toEqual([
      "/vercel/sandbox/repos/other",
      "/vercel/sandbox/repos/repo",
    ]);
    expect(instructions?.text).toBe(
      [
        "## /vercel/sandbox/repos/other",
        "",
        "other rules",
        "",
        "## /vercel/sandbox/repos/repo",
        "",
        "repo rules",
      ].join("\n"),
    );
    expect(sandbox.commandCount).toBe(1);
  });

  it("finds no worktrees when repos/ is missing", async () => {
    const sandbox = new HostSandbox()
      .file("/vercel/sandbox/repo/.git", "gitdir: elsewhere")
      .file("/vercel/sandbox/repo/AGENTS.md", "root-level clone");

    expect(await sandbox.read()).toEqual({
      directories: [],
      instructions: undefined,
    });
  });
});
