import { describe, expect, it } from "vitest";
import {
  discoverSkills,
  parseSkillInvocation,
  renderActiveSkillsXml,
  renderSkillMetadataXml,
  renderSkillsHarnessXml
} from "@/chat/skills";

describe("skills", () => {
  it("discovers valid skills from the default skills directory", async () => {
    const skills = await discoverSkills();
    expect(skills.some((skill) => skill.name === "summarize-candidate")).toBe(true);
  });

  it("parses skill invocation by slash command", () => {
    expect(parseSkillInvocation("/summarize-candidate github: octocat")).toEqual({
      skillName: "summarize-candidate",
      args: "github: octocat"
    });
  });

  it("does not parse invocation without slash command", () => {
    expect(parseSkillInvocation("please summarize this candidate")).toBeNull();
  });

  it("does not parse slash tokens that are not the full message command", () => {
    expect(parseSkillInvocation("hey /summarize-candidate github: octocat")).toBeNull();
  });

  it("renders available and active skill XML blocks", () => {
    const metadataXml = renderSkillMetadataXml([
      {
        name: "summarize-candidate",
        description: "Summarize candidate <profiles> & references",
        skillPath: "/tmp/summarize-candidate"
      }
    ]);

    const activeXml = renderActiveSkillsXml([
      {
        name: "summarize-candidate",
        description: "Summarize candidate profiles",
        skillPath: "/tmp/summarize-candidate",
        body: "# Instructions"
      }
    ]);
    const harnessXml = renderSkillsHarnessXml([
      {
        name: "summarize-candidate",
        description: "Summarize candidate profiles",
        skillPath: "/tmp/summarize-candidate"
      }
    ]);

    expect(metadataXml).toContain("<available_skills>");
    expect(metadataXml).toContain("&lt;profiles&gt;");
    expect(metadataXml).toContain("&amp; references");
    expect(metadataXml).toContain("<location>/tmp/summarize-candidate/SKILL.md</location>");
    expect(activeXml).toContain("<active_skills>");
    expect(harnessXml).toContain("<skills>");
  });
});
