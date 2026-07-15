import { describe, expect, it } from "vitest";
import {
  consumeRegisteredProjectCwds,
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
    async readdir() {
      return [];
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
  it("loads root-to-cwd instructions and prefers an override in each directory", async () => {
    const fs = memoryFs({
      "/vercel/sandbox/repo/.git": "directory",
      "/vercel/sandbox/repo/AGENTS.md": "root",
      "/vercel/sandbox/repo/packages/AGENTS.md": "package fallback",
      "/vercel/sandbox/repo/packages/AGENTS.override.md": "package override",
      "/vercel/sandbox/repo/packages/api/AGENTS.md": "api",
    });

    await expect(
      resolveProjectInstructions(fs, "/vercel/sandbox/repo/packages/api"),
    ).resolves.toEqual([
      { path: "/vercel/sandbox/repo/AGENTS.md", content: "root" },
      {
        path: "/vercel/sandbox/repo/packages/AGENTS.override.md",
        content: "package override",
      },
      {
        path: "/vercel/sandbox/repo/packages/api/AGENTS.md",
        content: "api",
      },
    ]);
  });

  it("consumes and de-duplicates post-checkout registrations", async () => {
    const registry = "/vercel/sandbox/.junior/project-cwds";
    const fs = memoryFs({
      [registry]: "/vercel/sandbox/one\n/vercel/sandbox/two\n/vercel/sandbox/one\n",
    });

    await expect(consumeRegisteredProjectCwds(fs)).resolves.toEqual([
      "/vercel/sandbox/one",
      "/vercel/sandbox/two",
    ]);
    await expect(consumeRegisteredProjectCwds(fs)).resolves.toEqual([]);
  });
});
