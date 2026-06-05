import { describe, expect, it } from "vitest";
import { parseSkillFile } from "@/chat/skills";

function skillFile(frontmatter: string[], body = "# Body"): string {
  return ["---", ...frontmatter, "---", "", body].join("\n");
}

describe("skill frontmatter validation", () => {
  it("accepts valid frontmatter", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        "metadata:",
        "  owner: recruiting",
      ]),
      "brief",
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.skill : null).toMatchObject({
      name: "brief",
      description: "Create a candidate brief from public engineering signals.",
      body: "# Body",
    });
  });

  it("rejects invalid name shape", () => {
    const result = parseSkillFile(
      skillFile(["name: bad--name", "description: Valid description"]),
      "bad--name",
    );

    expect(result.ok).toBe(false);
  });

  it("rejects descriptions with angle brackets", () => {
    const result = parseSkillFile(
      skillFile(["name: brief", "description: Brief <candidate> profile"]),
      "brief",
    );

    expect(result.ok).toBe(false);
  });

  it("rejects requires-capabilities frontmatter", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        "requires-capabilities: github.issues.read github.issues.write",
      ]),
      "brief",
    );

    expect(result.ok).toBe(false);
  });

  it("rejects uses-config frontmatter", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        "uses-config: eval-oauth.repo",
      ]),
      "brief",
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Frontmatter field "uses-config" is no longer supported; plugin config keys come from plugin.yaml.',
    });
  });

  it("parses disable-model-invocation: true", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        "disable-model-invocation: true",
      ]),
      "brief",
    );

    expect(result.ok).toBe(true);
    expect(result.ok ? result.skill.disableModelInvocation : undefined).toBe(
      true,
    );
  });

  it("omits disableModelInvocation when field is absent", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
      ]),
      "brief",
    );

    expect(result.ok).toBe(true);
    expect(
      result.ok ? result.skill.disableModelInvocation : "not-ok",
    ).toBeUndefined();
  });

  it("omits disableModelInvocation when field is false", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        "disable-model-invocation: false",
      ]),
      "brief",
    );

    expect(result.ok).toBe(true);
    expect(
      result.ok ? result.skill.disableModelInvocation : "not-ok",
    ).toBeUndefined();
  });

  it("rejects disable-model-invocation with non-boolean value", () => {
    const result = parseSkillFile(
      skillFile([
        "name: brief",
        "description: Create a candidate brief from public engineering signals.",
        'disable-model-invocation: "yes"',
      ]),
      "brief",
    );

    expect(result.ok).toBe(false);
  });
});
