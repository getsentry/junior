import { describe, expect, it } from "vitest";

import {
  reviewMarkdown,
  type ReviewDecision,
} from "../src/client/walkthrough/walkthroughModel";

const updatedAt = "2026-11-11T00:00:00.000Z";
const decisions: ReviewDecision[] = [
  {
    id: "fork-prs",
    question: "Should forks stop the stack walk?",
    chapterIndex: 1,
    prs: [3088],
    location: {
      label: "packages/junior-github/src/code-changes.ts:143",
      url: "https://github.com/getsentry/junior/blob/abc/packages/junior-github/src/code-changes.ts#L143",
    },
  },
  {
    id: "no-fk",
    question: "Is no foreign key fine here?",
    chapterIndex: 2,
    prs: [3088],
    location: { label: "src/db/schema/walkthroughs.ts:39" },
  },
  {
    id: "other-layer",
    question: "Does this belong in #3090?",
    chapterIndex: 3,
    prs: [3090],
  },
];

describe("Walkthrough review text", () => {
  it("puts the comment first, then requested changes with code links, then agreements", () => {
    expect(
      reviewMarkdown({
        answers: {
          "fork-prs": {
            decisionId: "fork-prs",
            value: "change",
            note: "Stop at forks.",
            updatedAt,
          },
          "no-fk": { decisionId: "no-fk", value: "agree", updatedAt },
          "other-layer": {
            decisionId: "other-layer",
            value: "change",
            updatedAt,
          },
        },
        comment: "  Nice stack.  ",
        decisions,
        pr: 3088,
      }),
    ).toBe(
      [
        "Nice stack.",
        "**Changes requested**",
        "1. Stop at forks. ([`packages/junior-github/src/code-changes.ts:143`](https://github.com/getsentry/junior/blob/abc/packages/junior-github/src/code-changes.ts#L143))\n   > Should forks stop the stack walk?",
        "**Agreed**\n- Is no foreign key fine here?",
      ].join("\n\n"),
    );
  });

  it("is empty until the reviewer answers or comments", () => {
    expect(
      reviewMarkdown({ answers: {}, comment: " ", decisions, pr: 3088 }),
    ).toBe("");
  });
});
