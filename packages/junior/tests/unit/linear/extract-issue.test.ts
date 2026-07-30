import { describe, expect, it } from "vitest";
import { extractLinearIssueLink } from "../../../../junior-linear/src/extract-issue.js";

describe("extractLinearIssueLink", () => {
  it("reads nested structured issue fields", () => {
    expect(
      extractLinearIssueLink({
        content: [{ type: "text", text: "Created something" }],
        structuredContent: {
          issue: {
            id: "uuid",
            identifier: "eng-42",
            title: "Example",
            url: "https://linear.app/acme/issue/ENG-42/from-structured",
          },
        },
      }),
    ).toEqual({
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42/from-structured",
    });
  });

  it("reads top-level structured issue fields", () => {
    expect(
      extractLinearIssueLink({
        content: [],
        structuredContent: {
          identifier: "ENG-7",
          url: "https://linear.app/acme/issue/ENG-7/top-level",
        },
      }),
    ).toEqual({
      identifier: "ENG-7",
      url: "https://linear.app/acme/issue/ENG-7/top-level",
    });
  });

  it("reads issue fields from JSON text content", () => {
    expect(
      extractLinearIssueLink({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              issue: {
                identifier: "ENG-11",
                url: "https://linear.app/acme/issue/ENG-11/from-json",
              },
            }),
          },
        ],
      }),
    ).toEqual({
      identifier: "ENG-11",
      url: "https://linear.app/acme/issue/ENG-11/from-json",
    });
  });

  it("falls back to Linear issue URLs in text content", () => {
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

  it("returns null when required identity fields are missing", () => {
    expect(
      extractLinearIssueLink({
        content: [{ type: "text", text: "No issue here" }],
        structuredContent: { issue: { title: "Incomplete" } },
      }),
    ).toBeNull();
  });
});
