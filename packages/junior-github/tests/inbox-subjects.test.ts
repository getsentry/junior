import type { ObjectAnnotation } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { pullRequestAsk } from "../src/inbox-subjects";

// The live card of a pull request, as the object-link resolver reads it.
function card(
  facts: Partial<Extract<ObjectAnnotation["facts"], { type: "code_change" }>>,
): ObjectAnnotation {
  return {
    facts: { type: "code_change", ...facts },
    key: "getsentry/junior#946",
    kind: "object",
    label: "getsentry/junior#946",
    objectType: "code_change",
    title: "Fix the thing",
    url: "https://github.com/getsentry/junior/pull/946",
  };
}

describe("pull request ask", () => {
  it("names the ask on one pull request", () => {
    expect(pullRequestAsk(card({ reviewers: ["Bo"] }))).toBe(
      "Review requested",
    );
    // Ana asked for the pull request, and GitHub still requests her review
    // after Bo approves it. Her ask is the merge.
    expect(
      pullRequestAsk(card({ review: "approved", reviewers: ["Ana", "Bo"] })),
    ).toBe("Ready to merge");
    // A conflict has its own item, so a pull request that cannot merge is
    // no merge ask.
    expect(pullRequestAsk(card({ mergeable: false, review: "approved" }))).toBe(
      "Review requested",
    );
    expect(pullRequestAsk(card({}))).toBe("Review requested");
    // GitHub does not merge a draft, even an approved one.
    expect(
      pullRequestAsk({ ...card({ review: "approved" }), status: "draft" }),
    ).toBe("Review requested");
  });
});
