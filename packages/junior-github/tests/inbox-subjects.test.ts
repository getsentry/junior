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
  it("names the ask of each viewer of one pull request", () => {
    const approved = card({ review: "approved", reviewers: ["Bo"] });
    // GitHub still requests Bo's review, in any case of his login.
    expect(pullRequestAsk(approved, { handle: "bo" })).toBe("Review requested");
    // The requester's ask on the same pull request is the merge.
    expect(pullRequestAsk(approved, { handle: "ana" })).toBe("Ready to merge");
    expect(pullRequestAsk(card({ mergeable: false }), { handle: "ana" })).toBe(
      "Merge conflict",
    );
    expect(pullRequestAsk(card({}), {})).toBe("Review requested");
  });
});
