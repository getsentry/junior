import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetSpanAttributes } from "@/chat/logging";
import { syncSkillsToSandbox } from "@/chat/sandbox/skill-sync";
import { sandboxSkillFile } from "@/chat/sandbox/paths";
import { discoverSkills, resetSkillDiscoveryCache } from "@/chat/skills";
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
  callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
): Promise<T> {
  return callback(() => {});
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
    const sandbox = {
      async readFileToBuffer() {
        return null;
      },
      async writeFiles(files: Array<{ path: string }>) {
        writtenPaths.push(...files.map((file) => file.path));
      },
    };

    await syncSkillsToSandbox({
      sandbox,
      skills: [builtInSkill],
      withSpan: immediateSpan,
    });

    expect(writtenPaths).toContain(sandboxSkillFile("jr-rpc"));
  });

  it("uploads nested skill files in one write without creating directories", async () => {
    const skillPath = await makeSkill();
    const uploads: string[][] = [];
    const sandbox = {
      async readFileToBuffer() {
        return null;
      },
      async writeFiles(files: Array<{ path: string }>) {
        uploads.push(files.map((file) => file.path));
      },
    };

    await syncSkillsToSandbox({
      sandbox,
      skills: [{ name: "demo", description: "Demo", skillPath }],
      withSpan: immediateSpan,
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toEqual(
      expect.arrayContaining([
        sandboxSkillFile("demo"),
        `${path.posix.dirname(sandboxSkillFile("demo"))}/references/nested/note.md`,
      ]),
    );
  });

  it("skips the copy until the skill files change", async () => {
    const skillPath = await makeSkill();
    const sandboxFiles = new Map<string, Buffer>();
    let writeCount = 0;
    const sandbox = {
      async readFileToBuffer(input: { path: string }) {
        return sandboxFiles.get(input.path) ?? null;
      },
      async writeFiles(files: Array<{ path: string; content: Uint8Array }>) {
        writeCount += 1;
        for (const file of files) {
          sandboxFiles.set(file.path, Buffer.from(file.content));
        }
      },
    };
    const sync = () =>
      syncSkillsToSandbox({
        sandbox,
        skills: [{ name: "demo", description: "Demo", skillPath }],
        withSpan: immediateSpan,
      });

    await sync();
    const firstWriteCount = writeCount;
    expect(sandboxFiles.get(sandboxSkillFile("demo"))?.toString()).toBe(
      "skill",
    );

    await sync();
    expect(writeCount).toBe(firstWriteCount);

    await fs.writeFile(path.join(skillPath, "SKILL.md"), "changed", "utf8");
    await sync();
    expect(writeCount).toBeGreaterThan(firstWriteCount);
    expect(sandboxFiles.get(sandboxSkillFile("demo"))?.toString()).toBe(
      "changed",
    );
  });
});
