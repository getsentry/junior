import { describe, expect, it } from "vitest";
import { githubPlugin } from "../src/plugin.js";
import { linkifyGitHubReferences } from "../src/reply-markdown.js";

describe("GitHub reply markdown", () => {
  it("turns repository issue references into links", () => {
    expect(linkifyGitHubReferences("opened getsentry/junior#1509 for review")).toBe(
      "opened [getsentry/junior#1509](https://github.com/getsentry/junior/issues/1509) for review",
    );
  });

  it("does not rewrite references in code, links, angle tokens, or URLs", () => {
    expect(
      linkifyGitHubReferences(
        [
          "`getsentry/junior#1509`",
          "[getsentry/junior#1509](https://github.com/getsentry/junior/pull/1509)",
          "[PR (draft) getsentry/junior#1509](https://github.com/getsentry/junior/pull/1509)",
          "<https://example.com/getsentry/junior#1509>",
          "https://example.com/getsentry/junior#1509",
          "```",
          "getsentry/junior#1509",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "`getsentry/junior#1509`",
        "[getsentry/junior#1509](https://github.com/getsentry/junior/pull/1509)",
        "[PR (draft) getsentry/junior#1509](https://github.com/getsentry/junior/pull/1509)",
        "<https://example.com/getsentry/junior#1509>",
        "https://example.com/getsentry/junior#1509",
        "```",
        "getsentry/junior#1509",
        "```",
      ].join("\n"),
    );
  });

  it("leaves ambiguous references unchanged", () => {
    expect(linkifyGitHubReferences("PR #1509 and foo.getsentry/junior#1509")).toBe(
      "PR #1509 and foo.getsentry/junior#1509",
    );
  });

  it("registers linkification on the GitHub plugin", () => {
    const hook = githubPlugin().hooks?.formatMarkdown;

    expect(hook).toBeDefined();
    expect(hook?.({ text: "getsentry/junior#1509" })).toBe(
      "[getsentry/junior#1509](https://github.com/getsentry/junior/issues/1509)",
    );
  });
});
