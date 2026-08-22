import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import { sandboxSkillFile } from "@/chat/sandbox/paths";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import { discoverSkills, resetSkillDiscoveryCache } from "@/chat/skills";


/** Test-only bridge for intentionally incomplete doubles. */
function asTestDouble<T>(value: unknown): T {
  return value as T;
}
const temporaryDirectories: string[] = [];

async function makeSkill(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-skill-sync-"));
  temporaryDirectories.push(root);
  await fs.mkdir(path.join(root, "references", "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "skill", "utf8");
  await fs.writeFile(
    path.join(root, "references", "nested", "note.md"),
    "note",
    "utf8",
  );
  await fs.writeFile(path.join(root, "scripts", "run.sh"), "run", "utf8");
  return root;
}

function immediateSpan<T>(
  _name: string,
  _op: string,
  _attributes: Record<string, unknown>,
  callback: () => Promise<T>,
): Promise<T> {
  return callback();
}

afterEach(async () => {
  resetSkillDiscoveryCache();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("sandbox skill sync", () => {
  it("copies discovered built-in skills into the sandbox", async () => {
    const builtInSkill = (await discoverSkills()).find(
      (skill) => skill.name === "jr-rpc",
    );
    if (!builtInSkill) {
      throw new Error("Expected the jr-rpc built-in skill");
    }

    const writtenPaths: string[] = [];
    const sandbox = asTestDouble<SandboxSession>({
      async mkDir() {},
      async readFileToBuffer() {
        return null;
      },
      async writeFiles(files: Array<{ path: string }>) {
        writtenPaths.push(...files.map((file) => file.path));
      },
    });

    await syncSkillsToSandbox({
      sandbox,
      skills: [builtInSkill],
      withSpan: immediateSpan,
    });

    expect(writtenPaths).toContain(sandboxSkillFile("jr-rpc"));
  });

  it("creates sibling directories concurrently after their parents", async () => {
    const skillPath = await makeSkill();
    let parentMissing = false;
    const createdDirectories = new Set<string>();
    const siblingDirectories = new Set<string>();
    let reportFirstSibling: (() => void) | undefined;
    const firstSiblingStarted = new Promise<void>((resolve) => {
      reportFirstSibling = resolve;
    });
    let releaseSiblings: (() => void) | undefined;
    const siblingsStarted = new Promise<void>((resolve) => {
      releaseSiblings = resolve;
    });
    const sandbox = asTestDouble<SandboxSession>({
      async mkDir(directory: string) {
        const parent = path.posix.dirname(directory);
        if (
          parent.startsWith("/vercel/sandbox") &&
          !createdDirectories.has(parent)
        ) {
          parentMissing = true;
        }
        if (
          directory.endsWith("/references") ||
          directory.endsWith("/scripts")
        ) {
          siblingDirectories.add(directory);
          reportFirstSibling?.();
          if (siblingDirectories.size < 2) {
            await siblingsStarted;
          }
        }
        createdDirectories.add(directory);
      },
      async readFileToBuffer() {
        return null;
      },
      async writeFiles() {},
    });

    const sync = syncSkillsToSandbox({
      sandbox,
      skills: [{ name: "demo", description: "Demo", skillPath }],
      withSpan: immediateSpan,
    });

    await firstSiblingStarted;
    expect(siblingDirectories.size).toBe(2);
    releaseSiblings?.();
    await sync;
    expect(parentMissing).toBe(false);
  });
});
