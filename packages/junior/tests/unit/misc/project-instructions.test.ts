import { describe, expect, it } from "vitest";
import {
  discoverWorkspaceProjectRoots,
  resolveProjectInstructions,
} from "@/chat/sandbox/project-instructions";
import type {
  SandboxFileStat,
  SandboxFileSystem,
} from "@/chat/sandbox/workspace";

function memoryFs(initial: Record<string, string | "directory">): SandboxFileSystem {
  const entries = new Map(Object.entries(initial));
  return {
    async readFile(filePath) {
      const value = entries.get(filePath);
      if (typeof value !== "string") {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return value;
    },
    async writeFile(filePath, content) {
      entries.set(filePath, content);
    },
    async readdir(filePath) {
      const prefix = `${filePath}/`;
      return [
        ...new Set(
          [...entries.keys()]
            .filter((entry) => entry.startsWith(prefix))
            .map((entry) => entry.slice(prefix.length).split("/")[0])
            .filter((entry): entry is string => Boolean(entry)),
        ),
      ];
    },
    async stat(filePath): Promise<SandboxFileStat> {
      const value = entries.get(filePath);
      if (value === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return { isDirectory: () => value === "directory" };
    },
  };
}

describe("project instructions", () => {
  it("loads AGENTS.md instructions from the project root through the cwd", async () => {
    const fs = memoryFs({
      "/vercel/sandbox/repo/.git": "directory",
      "/vercel/sandbox/repo/AGENTS.md": "root",
      "/vercel/sandbox/repo/packages/AGENTS.md": "package",
      "/vercel/sandbox/repo/packages/api/AGENTS.md": "api",
    });

    await expect(
      resolveProjectInstructions(fs, "/vercel/sandbox/repo/packages/api"),
    ).resolves.toEqual([
      { path: "/vercel/sandbox/repo/AGENTS.md", content: "root" },
      {
        path: "/vercel/sandbox/repo/packages/AGENTS.md",
        content: "package",
      },
      {
        path: "/vercel/sandbox/repo/packages/api/AGENTS.md",
        content: "api",
      },
    ]);
  });

  it("discovers repositories checked out under the workspace root", async () => {
    const fs = memoryFs({
      "/vercel/sandbox/one/.git": "directory",
      "/vercel/sandbox/two/.git": "directory",
      "/vercel/sandbox/not-a-repo/file.txt": "content",
    });

    await expect(discoverWorkspaceProjectRoots(fs)).resolves.toEqual([
      "/vercel/sandbox/one",
      "/vercel/sandbox/two",
    ]);
  });
});
