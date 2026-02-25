import { describe, expect, it } from "vitest";
import { SkillSandbox } from "@/chat/skill-sandbox";
import { discoverSkills } from "@/chat/skills";

describe("skill sandbox", () => {
  it("loads a skill and reads files from its directory", async () => {
    const availableSkills = await discoverSkills();
    const sandbox = new SkillSandbox(availableSkills);

    const loaded = await sandbox.loadSkill("brief");
    expect(loaded?.name).toBe("brief");

    const listing = await sandbox.listFiles({ directory: "." });
    expect(listing.entries.some((entry) => entry.path === "references/" && entry.type === "directory")).toBe(true);

    const file = await sandbox.readFile({ filePath: "references/candidate-rubric.md" });
    expect(file.path).toBe("references/candidate-rubric.md");
    expect(file.content.length).toBeGreaterThan(0);
  });

  it("blocks traversal outside the skill directory", async () => {
    const availableSkills = await discoverSkills();
    const sandbox = new SkillSandbox(availableSkills);

    await sandbox.loadSkill("brief");
    await expect(sandbox.readFile({ filePath: "../README.md" })).rejects.toThrow("escapes");
  });

  it("maps allowed-tools aliases to runtime tool names", () => {
    const sandbox = new SkillSandbox(
      [
        {
          name: "demo",
          description: "Demo",
          skillPath: "/tmp/demo"
        }
      ],
      [
        {
          name: "demo",
          description: "Demo",
          skillPath: "/tmp/demo",
          allowedTools: ["Read", "web_search", "Bash(git:*)"],
          body: "demo body"
        }
      ]
    );

    const filtered = sandbox.filterToolNames([
      "read_skill_file",
      "list_skill_files",
      "web_search",
      "web_fetch",
      "final_answer"
    ]);

    expect(filtered).toEqual(["read_skill_file", "web_search", "final_answer"]);
  });
});
