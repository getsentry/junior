import { describe, expect, it } from "vitest";
import { parseSkillFile } from "@/chat/skill-frontmatter";

describe("skill frontmatter validation", () => {
  it("accepts valid frontmatter", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "metadata:",
      "  owner: recruiting",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.skill : null).toMatchObject({
      name: "brief",
      description: "Create a candidate brief from public engineering signals.",
      body: "# Body",
    });
  });

  it("rejects invalid name shape", () => {
    const raw = [
      "---",
      "name: bad--name",
      "description: Valid description",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "bad--name");
    expect(result.ok).toBe(false);
  });

  it("rejects descriptions with angle brackets", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Brief <candidate> profile",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(false);
  });

  it("accepts valid requires-capabilities tokens", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "requires-capabilities: github.issues.read github.issues.write",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.skill.requiresCapabilities : null).toEqual([
      "github.issues.read",
      "github.issues.write",
    ]);
  });

  it("rejects invalid requires-capabilities tokens", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "requires-capabilities: github",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(false);
  });

  it("accepts valid uses-config tokens", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "uses-config: github.repo jira.project",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.skill.usesConfig : null).toEqual([
      "github.repo",
      "jira.project",
    ]);
  });

  it("rejects invalid uses-config tokens", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "uses-config: GITHUB_REPO",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result.ok).toBe(false);
  });
});
