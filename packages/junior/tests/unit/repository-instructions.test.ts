import { describe, expect, it } from "vitest";
import {
  AGENTS_REMOVAL_NOTICE,
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
  findSingleRepositoryDirectory,
  listRepositoryDirectories,
  renderAgentsInstructions,
  resolveRepositoryInstructions,
  resolveRepositoryInstructionsForDirectories,
} from "@/chat/repository-instructions";
import type {
  SandboxFileStat,
  SandboxFileSystem,
} from "@/chat/sandbox/workspace";

class MemoryFileSystem implements SandboxFileSystem {
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();

  directory(path: string): this {
    this.directories.add(path);
    return this;
  }

  file(path: string, content: string): this {
    this.files.set(path, content);
    return this;
  }

  async readFile(filePath: string): Promise<string> {
    const content = this.files.get(filePath);
    if (content === undefined) throw missing(filePath);
    return content;
  }

  async writeFile(): Promise<void> {
    throw new Error("not implemented");
  }

  async readdir(filePath: string): Promise<string[]> {
    if (!this.directories.has(filePath)) throw missing(filePath);
    const prefix = `${filePath}/`;
    return [...this.directories, ...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix))
      .map((candidate) => candidate.slice(prefix.length).split("/", 1)[0]!)
      .filter((entry, index, entries) => entries.indexOf(entry) === index);
  }

  async stat(filePath: string): Promise<SandboxFileStat> {
    if (this.directories.has(filePath)) {
      return { isDirectory: () => true };
    }
    if (this.files.has(filePath)) {
      return { isDirectory: () => false };
    }
    throw missing(filePath);
  }
}

function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`File not found: ${path}`), {
    code: "ENOENT",
  });
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
    const fs = new MemoryFileSystem()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repo")
      .directory("/vercel/sandbox/repo/.git")
      .directory("/vercel/sandbox/repo/packages")
      .directory("/vercel/sandbox/repo/packages/api")
      .file("/vercel/sandbox/repo/AGENTS.md", "root rules")
      .file("/vercel/sandbox/repo/packages/api/AGENTS.md", "api rules");

    const instructions = await resolveRepositoryInstructions({
      cwd: "/vercel/sandbox/repo/packages/api",
      fs,
    });

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
    const fs = new MemoryFileSystem()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/sentry")
      .directory("/vercel/sandbox/repos/sentry/.git")
      .directory("/vercel/sandbox/repos/relay")
      .directory("/vercel/sandbox/repos/relay/.git")
      .file("/vercel/sandbox/repos/sentry/AGENTS.md", "sentry rules")
      .file("/vercel/sandbox/repos/relay/AGENTS.md", "relay rules");

    const instructions = await resolveRepositoryInstructionsForDirectories({
      directories: [
        "/vercel/sandbox/repos/sentry",
        "/vercel/sandbox/repos/relay",
      ],
      fs,
    });

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
  });

  it("lists Git worktrees under repos/", async () => {
    const fs = new MemoryFileSystem()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repos")
      .directory("/vercel/sandbox/repos/repo")
      .file("/vercel/sandbox/repos/repo/.git", "gitdir: elsewhere");

    expect(await listRepositoryDirectories(fs)).toEqual([
      "/vercel/sandbox/repos/repo",
    ]);
    expect(await findSingleRepositoryDirectory(fs)).toBe(
      "/vercel/sandbox/repos/repo",
    );

    fs.directory("/vercel/sandbox/repos/other").directory(
      "/vercel/sandbox/repos/other/.git",
    );
    expect(await listRepositoryDirectories(fs)).toEqual([
      "/vercel/sandbox/repos/other",
      "/vercel/sandbox/repos/repo",
    ]);
    expect(await findSingleRepositoryDirectory(fs)).toBeUndefined();
  });

  it("ignores root-level clones outside repos/", async () => {
    const fs = new MemoryFileSystem()
      .directory("/vercel/sandbox")
      .directory("/vercel/sandbox/repo")
      .file("/vercel/sandbox/repo/.git", "gitdir: elsewhere");

    expect(await findSingleRepositoryDirectory(fs)).toBeUndefined();
  });
});
