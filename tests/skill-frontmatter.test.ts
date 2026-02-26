import { describe, expect, it } from "vitest";
import { parseAndValidateSkillFrontmatter } from "@/chat/skill-frontmatter";

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
      "# Body"
    ].join("\n");

    const result = parseAndValidateSkillFrontmatter(raw, "brief");
    expect(result.ok).toBe(true);
  });

  it("rejects invalid name shape", () => {
    const raw = [
      "---",
      "name: bad--name",
      "description: Valid description",
      "---",
      "",
      "# Body"
    ].join("\n");

    const result = parseAndValidateSkillFrontmatter(raw, "bad--name");
    expect(result.ok).toBe(false);
  });

  it("rejects descriptions with angle brackets", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Brief <candidate> profile",
      "---",
      "",
      "# Body"
    ].join("\n");

    const result = parseAndValidateSkillFrontmatter(raw, "brief");
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
      "# Body"
    ].join("\n");

    const result = parseAndValidateSkillFrontmatter(raw, "brief");
    expect(result.ok).toBe(true);
  });

  it("rejects invalid requires-capabilities tokens", () => {
    const raw = [
      "---",
      "name: brief",
      "description: Create a candidate brief from public engineering signals.",
      "requires-capabilities: github",
      "---",
      "",
      "# Body"
    ].join("\n");

    const result = parseAndValidateSkillFrontmatter(raw, "brief");
    expect(result.ok).toBe(false);
  });
});
