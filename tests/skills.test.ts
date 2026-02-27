import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  discoverSkills,
  parseSkillInvocation,
  resetSkillDiscoveryCache,
  renderActiveSkillsXml,
  renderSkillMetadataXml,
  renderSkillsHarnessXml
} from "@/chat/skills";
import * as observability from "@/chat/observability";

async function writeSkillFile(rootDir: string, name: string, lines: string[]): Promise<void> {
  const skillDir = path.join(rootDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf8");
}

describe("skills", () => {
  it("discovers valid skills from the default skills directory", async () => {
    const skills = await discoverSkills();
    const names = skills.map((skill) => skill.name);

    expect(names).toContain("brief");
    expect(names).toContain("sum");
    expect(names).not.toContain("slack-development");
    expect(names).not.toContain("use-ai-sdk");
  });

  it("parses skill invocation by slash command", () => {
    expect(parseSkillInvocation("/brief github: octocat")).toEqual({
      skillName: "brief",
      args: "github: octocat"
    });
  });

  it("does not parse invocation without slash command", () => {
    expect(parseSkillInvocation("please summarize this candidate")).toBeNull();
  });

  it("parses slash tokens anywhere in the message", () => {
    expect(parseSkillInvocation("hey /brief github: octocat")).toEqual({
      skillName: "brief",
      args: "github: octocat"
    });
  });

  it("renders available and active skill XML blocks", () => {
    const metadataXml = renderSkillMetadataXml([
      {
        name: "brief",
        description: "Candidate brief <profiles> & references",
        skillPath: "/tmp/brief"
      }
    ]);

    const activeXml = renderActiveSkillsXml([
      {
        name: "brief",
        description: "Candidate brief profiles",
        skillPath: "/tmp/brief",
        body: "# Instructions"
      }
    ]);
    const harnessXml = renderSkillsHarnessXml([
      {
        name: "brief",
        description: "Candidate brief profiles",
        skillPath: "/tmp/brief"
      }
    ]);

    expect(metadataXml).toContain("<available_skills>");
    expect(metadataXml).toContain("&lt;profiles&gt;");
    expect(metadataXml).toContain("&amp; references");
    expect(metadataXml).toContain("<location>/tmp/brief/SKILL.md</location>");
    expect(activeXml).toContain("<active_skills>");
    expect(harnessXml).toContain("<skills>");
  });

  it("skips skills with unknown capability/config metadata and logs warnings", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-skills-"));
    const originalSkillDirs = process.env.SKILL_DIRS;
    const warnSpy = vi.spyOn(observability, "logWarn").mockImplementation(() => undefined);

    try {
      await writeSkillFile(tempRoot, "tmp-valid-metadata", [
        "---",
        "name: tmp-valid-metadata",
        "description: Valid metadata skill.",
        "requires-capabilities: github.issues.read",
        "uses-config: github.repo",
        "---",
        "",
        "# Body"
      ]);
      await writeSkillFile(tempRoot, "tmp-invalid-capability", [
        "---",
        "name: tmp-invalid-capability",
        "description: Invalid capability metadata skill.",
        "requires-capabilities: github.unknown.read",
        "---",
        "",
        "# Body"
      ]);
      await writeSkillFile(tempRoot, "tmp-invalid-config", [
        "---",
        "name: tmp-invalid-config",
        "description: Invalid config metadata skill.",
        "uses-config: github.organization",
        "---",
        "",
        "# Body"
      ]);

      process.env.SKILL_DIRS = tempRoot;
      resetSkillDiscoveryCache();

      const skills = await discoverSkills();
      const names = skills.map((skill) => skill.name);

      expect(names).toContain("tmp-valid-metadata");
      expect(names).not.toContain("tmp-invalid-capability");
      expect(names).not.toContain("tmp-invalid-config");

      const warningCalls = warnSpy.mock.calls.filter(([event]) => event === "skill_frontmatter_invalid");
      const warningMessages = warningCalls
        .map((call) => call[2])
        .map((attributes) => String(attributes?.["error.message"] ?? ""));
      expect(warningMessages.some((message) => message.includes("Unknown requires-capabilities values"))).toBe(true);
      expect(warningMessages.some((message) => message.includes("Unknown uses-config values"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetSkillDiscoveryCache();
      if (originalSkillDirs === undefined) {
        delete process.env.SKILL_DIRS;
      } else {
        process.env.SKILL_DIRS = originalSkillDirs;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
