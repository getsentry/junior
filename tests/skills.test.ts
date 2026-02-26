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
});
