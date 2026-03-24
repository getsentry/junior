import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SkillSandbox } from "@/chat/sandbox/skill-sandbox";
import { discoverSkills } from "@/chat/skills";

describe("skill sandbox", () => {
  it("loads a skill and reads files from its directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-sandbox-"),
    );
    const briefDir = path.join(tempRoot, "brief");
    const refsDir = path.join(briefDir, "references");
    await fs.mkdir(refsDir, { recursive: true });
    await fs.writeFile(
      path.join(briefDir, "SKILL.md"),
      [
        "---",
        "name: brief",
        "description: Candidate brief",
        "---",
        "",
        "# Brief skill",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(refsDir, "candidate-rubric.md"),
      "# Candidate Rubric\n",
      "utf8",
    );

    try {
      const availableSkills = await discoverSkills({
        additionalRoots: [tempRoot],
      });
      const sandbox = new SkillSandbox(availableSkills);

      const loaded = await sandbox.loadSkill("brief");
      expect(loaded?.name).toBe("brief");

      const listing = await sandbox.listFiles({ directory: "." });
      expect(
        listing.entries.some(
          (entry) => entry.path === "references/" && entry.type === "directory",
        ),
      ).toBe(true);

      const file = await sandbox.readFile({
        filePath: "references/candidate-rubric.md",
      });
      expect(file.path).toBe("references/candidate-rubric.md");
      expect(file.content.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks traversal outside the skill directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-sandbox-"),
    );
    const briefDir = path.join(tempRoot, "brief");
    await fs.mkdir(briefDir, { recursive: true });
    await fs.writeFile(
      path.join(briefDir, "SKILL.md"),
      [
        "---",
        "name: brief",
        "description: Candidate brief",
        "---",
        "",
        "# Brief skill",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(briefDir, "README.md"), "local file", "utf8");

    try {
      const availableSkills = await discoverSkills({
        additionalRoots: [tempRoot],
      });
      const sandbox = new SkillSandbox(availableSkills);

      await sandbox.loadSkill("brief");
      await expect(
        sandbox.readFile({ filePath: "../README.md" }),
      ).rejects.toThrow("escapes");
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts only exact runtime tool names in allowed-tools", () => {
    const sandbox = new SkillSandbox(
      [
        {
          name: "demo",
          description: "Demo",
          skillPath: "/tmp/demo",
        },
      ],
      [
        {
          name: "demo",
          description: "Demo",
          skillPath: "/tmp/demo",
          allowedTools: ["Read", "web_search", "Bash(git:*)", "bash"],
          body: "demo body",
        },
      ],
    );

    const filtered = sandbox.filterToolNames([
      "bash",
      "web_search",
      "web_fetch",
    ]);

    expect(filtered).toEqual(["bash", "web_search"]);
  });
});
