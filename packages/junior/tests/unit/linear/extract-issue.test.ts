import { describe, expect, it } from "vitest";
import { extractLinearIssueLink } from "../../../../junior-linear/src/extract-issue.js";

describe("extractLinearIssueLink", () => {
  it("prefers structured identifier and url fields", () => {
    expect(
      extractLinearIssueLink({
        content: [{ type: "text", text: "Created something" }],
        structuredContent: {
          issue: {
            identifier: "eng-42",
            url: "https://linear.app/acme/issue/ENG-42/from-structured",
          },
        },
      }),
    ).toEqual({
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42/from-structured",
    });
  });

  it("falls back to markdown issue links in text content", () => {
    expect(
      extractLinearIssueLink({
        content: [
          {
            type: "text",
            text: "Created [ENG-99](https://linear.app/acme/issue/ENG-99/from-text)",
          },
        ],
      }),
    ).toEqual({
      identifier: "ENG-99",
      url: "https://linear.app/acme/issue/ENG-99/from-text",
    });
  });

  it("returns null when no issue identity is present", () => {
    expect(
      extractLinearIssueLink({
        content: [{ type: "text", text: "No issue here" }],
      }),
    ).toBeNull();
  });
});
