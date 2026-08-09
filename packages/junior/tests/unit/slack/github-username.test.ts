import { describe, expect, it } from "vitest";
import { normalizeGithubUsername } from "@/chat/slack/users";

describe("normalizeGithubUsername", () => {
  it("accepts bare logins and @handles", () => {
    expect(normalizeGithubUsername("dcramer")).toBe("dcramer");
    expect(normalizeGithubUsername("@DCramer")).toBe("dcramer");
  });

  it("accepts github.com profile URLs", () => {
    expect(normalizeGithubUsername("https://github.com/dcramer")).toBe(
      "dcramer",
    );
    expect(normalizeGithubUsername("github.com/dcramer/")).toBe("dcramer");
    expect(normalizeGithubUsername("https://www.github.com/dcramer")).toBe(
      "dcramer",
    );
  });

  it("rejects non-github values", () => {
    expect(normalizeGithubUsername("https://gitlab.com/dcramer")).toBeUndefined();
    expect(normalizeGithubUsername("not a login!!")).toBeUndefined();
    expect(normalizeGithubUsername("-bad")).toBeUndefined();
    expect(normalizeGithubUsername("")).toBeUndefined();
  });
});
