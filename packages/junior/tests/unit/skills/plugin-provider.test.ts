import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginAppFixture } from "../../fixtures/plugin-app";

const originalCwd = process.cwd();

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
  process.chdir(originalCwd);
  vi.resetModules();
});

describe("discoverSkills plugin ownership", () => {
  it("attaches pluginProvider only to plugin-owned skills", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-plugin-provider-"),
    );
    const pluginRoot = path.join(tempRoot, "demo");

    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "plugin.yaml"),
      ["name: demo", "display-name: Demo", "description: Demo plugin"].join(
        "\n",
      ),
      "utf8",
    );
    await writeSkill(path.join(pluginRoot, "skills"), "triage", "triage");

    try {
      const app = await createPluginAppFixture([pluginRoot]);
      try {
        await writeSkill(
          path.join(app.root, "app", "skills"),
          "notes",
          "notes",
        );
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
        await app.cleanup();
      }
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
