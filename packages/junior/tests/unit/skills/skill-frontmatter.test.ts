import { describe, expect, it } from "vitest";
import { parseSkillFile } from "@/chat/skills";

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

  it("rejects requires-capabilities frontmatter", () => {
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
    expect(result.ok).toBe(false);
  });

  it("rejects uses-config frontmatter", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "uses-config: eval-oauth.repo",
      "---",
      "",
      "# Body",
    ].join("\n");

    const result = parseSkillFile(raw, "brief");
    expect(result).toEqual({
      ok: false,
      error:
        'Frontmatter field "uses-config" is no longer supported; plugin config keys come from plugin.yaml.',
    });
  });

  it("rejects requires-capabilities even when invalid", () => {
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
});
