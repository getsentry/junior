import { describe, expect, it } from "vitest";
import { describeGitHubUrl } from "../src/describe-url";

describe("describeGitHubUrl", () => {
  it.each([
    "https://github.com/getsentry/junior",
    "https://github.com/getsentry/junior.git",
    "ssh://git@github.com/getsentry/junior.git",
  ])("reads the repository of %s", async (url) => {
    await expect(describeGitHubUrl(new URL(url))).resolves.toEqual({
      ref: "getsentry/junior",
      audience: "world",
      createdByThisWork: false,
    });
  });

  it.each([
    "https://gitlab.com/getsentry/junior",
    "https://github.com/getsentry",
  ])("knows no target for %s", async (url) => {
    await expect(describeGitHubUrl(new URL(url))).resolves.toBeUndefined();
  });
});
