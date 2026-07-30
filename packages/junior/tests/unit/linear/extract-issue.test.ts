import { describe, expect, it } from "vitest";
import { extractLinearIssueLink } from "../../../../junior-linear/src/extract-issue.js";

describe("extractLinearIssueLink", () => {
  it("reads the structured Linear issue response", () => {
    expect(
      extractLinearIssueLink({
        issue: {
          id: "uuid",
          identifier: "eng-42",
          title: "Example",
          url: "https://linear.app/acme/issue/ENG-42/from-structured",
        },
      }),
    ).toEqual({
      identifier: "ENG-42",
      url: "https://linear.app/acme/issue/ENG-42/from-structured",
    });
  });

  it("returns null when the response does not match", () => {
    expect(
      extractLinearIssueLink({ issue: { title: "Incomplete" } }),
    ).toBeNull();
    expect(
      extractLinearIssueLink({
        identifier: "ENG-7",
        url: "https://linear.app/acme/issue/ENG-7/top-level",
      }),
    ).toBeNull();
  });
});
