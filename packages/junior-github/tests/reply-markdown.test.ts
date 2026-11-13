import { describe, expect, it } from "vitest";
import { githubPlugin } from "../src/plugin.js";
import { linkifyGitHubReferences } from "../src/reply-markdown.js";

describe("GitHub reply markdown", () => {
  it("turns repository issue references into links", () => {
    expect(
      linkifyGitHubReferences("opened getsentry/junior#1509 for review"),
    ).toBe(
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
          "[see getsentry/junior#1509](/issues/1509)",
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
        "[see getsentry/junior#1509](/issues/1509)",
        "<https://example.com/getsentry/junior#1509>",
        "https://example.com/getsentry/junior#1509",
        "```",
        "getsentry/junior#1509",
        "```",
      ].join("\n"),
    );
  });

  it("keeps refs inside longer outer fences with inner fences", () => {
    expect(
      linkifyGitHubReferences(
        ["````md", "```", "getsentry/sentry#123", "```", "````"].join("\n"),
      ),
    ).toBe(["````md", "```", "getsentry/sentry#123", "```", "````"].join("\n"));
  });

  it("still linkifies refs after a bare bracketed token", () => {
    expect(
      linkifyGitHubReferences(
        "[note] getsentry/junior#1509 and [real](https://example.com/x)",
      ),
    ).toBe(
      "[note] [getsentry/junior#1509](https://github.com/getsentry/junior/issues/1509) and [real](https://example.com/x)",
    );
  });

  it("leaves ambiguous references unchanged", () => {
    expect(
      linkifyGitHubReferences("PR #1509 and foo.getsentry/junior#1509"),
    ).toBe("PR #1509 and foo.getsentry/junior#1509");
  });

  it("turns repository commit references into short commit links", () => {
    expect(
      linkifyGitHubReferences(
        "landed in getsentry/junior@2c1fefa8d1b2c3d4e5f60718293a4b5c6d7e8f90.",
      ),
    ).toBe(
      "landed in [getsentry/junior@2c1fefa](https://github.com/getsentry/junior/commit/2c1fefa8d1b2c3d4e5f60718293a4b5c6d7e8f90).",
    );
  });

  it("shortens bare GitHub issue, pull request, discussion, and commit URLs", () => {
    expect(
      linkifyGitHubReferences(
        [
          "https://github.com/getsentry/junior/pull/3313",
          "(https://github.com/getsentry/sentry/issues/42).",
          "https://github.com/getsentry/junior/discussions/7",
          "https://github.com/getsentry/junior/commit/2c1fefa8d",
          "https://github.com/getsentry/junior/pull/3313/files",
        ].join("\n"),
      ),
    ).toBe(
      [
        "[getsentry/junior#3313](https://github.com/getsentry/junior/pull/3313)",
        "([getsentry/sentry#42](https://github.com/getsentry/sentry/issues/42)).",
        "[getsentry/junior#7](https://github.com/getsentry/junior/discussions/7)",
        "[getsentry/junior@2c1fefa](https://github.com/getsentry/junior/commit/2c1fefa8d)",
        "https://github.com/getsentry/junior/pull/3313/files",
      ].join("\n"),
    );
  });

  it("resolves bare references against the one repository the text names", () => {
    const sha = "2c1fefa8d1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(
      linkifyGitHubReferences(
        `[PR](https://github.com/getsentry/junior/pull/3313) replaces #3300 and GH-3301 (#3302), see ${sha} and byk@${sha}`,
      ),
    ).toBe(
      [
        "[PR](https://github.com/getsentry/junior/pull/3313) replaces",
        "[#3300](https://github.com/getsentry/junior/issues/3300) and",
        "[GH-3301](https://github.com/getsentry/junior/issues/3301)",
        "([#3302](https://github.com/getsentry/junior/issues/3302)), see",
        `[2c1fefa](https://github.com/getsentry/junior/commit/${sha}) and`,
        `[byk@2c1fefa](https://github.com/byk/junior/commit/${sha})`,
      ].join(" "),
    );
  });

  it("leaves bare references unchanged when several repositories are named", () => {
    expect(
      linkifyGitHubReferences(
        "getsentry/junior#1 and getsentry/sentry#2 both mention #3",
      ),
    ).toBe(
      "[getsentry/junior#1](https://github.com/getsentry/junior/issues/1) and [getsentry/sentry#2](https://github.com/getsentry/sentry/issues/2) both mention #3",
    );
  });

  it("does not treat short hex IDs, entities, or emails as commits", () => {
    const text =
      "getsentry/junior#1: event 0123456789abcdef0123456789abcdef, &#39;, a@deadbeef.io, x#2";
    expect(linkifyGitHubReferences(text)).toBe(
      text.replace(
        "getsentry/junior#1",
        "[getsentry/junior#1](https://github.com/getsentry/junior/issues/1)",
      ),
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
