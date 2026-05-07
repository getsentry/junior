import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalSkillDirs = process.env.SKILL_DIRS;

async function writeSkill(
  rootDir: string,
  directoryName: string,
  skillName: string,
): Promise<void> {
  const skillDir = path.join(rootDir, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      `description: ${skillName} skill`,
      "---",
      "",
      "# Body",
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  if (originalSkillDirs === undefined) {
    delete process.env.SKILL_DIRS;
  } else {
    process.env.SKILL_DIRS = originalSkillDirs;
  }
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
  vi.doUnmock("@/chat/plugins/package-discovery");
});

describe("discoverSkills plugin ownership", () => {
  it("attaches pluginProvider only to plugin-owned skills", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-plugin-provider-"),
    );
    const pluginsRoot = path.join(tempRoot, "plugins");
    const pluginRoot = path.join(pluginsRoot, "demo");
    const localSkillsRoot = path.join(tempRoot, "skills");

    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "plugin.yaml"),
      ["name: demo", "description: Demo plugin"].join("\n"),
      "utf8",
    );
    await writeSkill(path.join(pluginRoot, "skills"), "triage", "triage");
    await writeSkill(localSkillsRoot, "notes", "notes");

    process.env.SKILL_DIRS = localSkillsRoot;

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [pluginsRoot],
      skillRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: [],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
    }));

    try {
      const { discoverSkills, resetSkillDiscoveryCache } =
        await import("@/chat/skills");
      resetSkillDiscoveryCache();

      const skills = await discoverSkills();
      expect(skills.find((skill) => skill.name === "triage")).toMatchObject({
        name: "triage",
        pluginProvider: "demo",
      });
      expect(skills.find((skill) => skill.name === "notes")).toMatchObject({
        name: "notes",
      });
      expect(
        skills.find((skill) => skill.name === "notes")?.pluginProvider,
      ).toBeUndefined();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
