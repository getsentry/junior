import { describe, expect, it } from "vitest";

import { walkthroughVersionSchema } from "@sentry/junior/api/schema";
import {
  reviewAnswers,
  reviewDecisions,
  reviewMarkdown,
  type ReviewDecision,
} from "../src/client/walkthrough/walkthroughModel";
import {
  changeSummary,
  lastSeenRank,
  walkthroughChapters,
} from "../src/client/walkthrough/walkthroughUpdates";
import {
  mockBaseAnswers,
  mockUpdateDocument,
  MOCK_UPDATE_IDS,
} from "../src/mock-reporting/walkthrough-update";
import stackRun from "../src/mock-reporting/walkthroughs/stack3089.json";

const updatedAt = "2026-11-11T00:00:00.000Z";
const versionId = "v1";
const decisions: ReviewDecision[] = [
  {
    id: "fork-prs",
    claim: "Forks need not stop the stack walk.",
    chapterId: "github-reads",
    chapterIndex: 1,
    prs: [3088],
    location: {
      label: "packages/junior-github/src/code-changes.ts:143",
      url: "https://github.com/getsentry/junior/blob/abc/packages/junior-github/src/code-changes.ts#L143",
    },
  },
  {
    id: "no-fk",
    claim: "No foreign key is needed here.",
    chapterId: "versions-table",
    chapterIndex: 2,
    prs: [3088],
    location: { label: "src/db/schema/walkthroughs.ts:39" },
  },
  {
    id: "later",
    claim: "The retry count can wait.",
    chapterId: "versions-table",
    chapterIndex: 2,
    prs: [3088],
  },
  {
    id: "other-layer",
    claim: "This belongs in #3090.",
    chapterId: "submit-tool",
    chapterIndex: 3,
    prs: [3090],
  },
];

describe("Walkthrough review text", () => {
  it("puts the comment first, then requested changes with code links, then agreements, and leaves skips out", () => {
    expect(
      reviewMarkdown({
        answers: {
          "fork-prs": {
            decisionId: "fork-prs",
            value: "change",
            note: "Stop at forks.",
            versionId,
            updatedAt,
          },
          "no-fk": {
            decisionId: "no-fk",
            value: "agree",
            versionId,
            updatedAt,
          },
          later: { decisionId: "later", value: "skip", versionId, updatedAt },
          "other-layer": {
            decisionId: "other-layer",
            value: "change",
            versionId,
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
        "1. Stop at forks. ([`packages/junior-github/src/code-changes.ts:143`](https://github.com/getsentry/junior/blob/abc/packages/junior-github/src/code-changes.ts#L143))\n   > Forks need not stop the stack walk.",
        "**Agreed**\n- No foreign key is needed here.",
      ].join("\n\n"),
    );
  });

  it("is empty until the reviewer answers or comments", () => {
    expect(
      reviewMarkdown({ answers: {}, comment: " ", decisions, pr: 3088 }),
    ).toBe("");
  });
});

describe("Walkthrough answers after an update", () => {
  const base = walkthroughVersionSchema.parse(stackRun).document!;
  const document = mockUpdateDocument({
    ...base,
    versionId: MOCK_UPDATE_IDS.base,
    contentVersionId: MOCK_UPDATE_IDS.base,
  });
  const answers = Object.fromEntries(
    mockBaseAnswers().map((answer) => [answer.decisionId, answer]),
  );

  it("keeps answers whose code did not change and reopens the rest", () => {
    const result = reviewAnswers(document, reviewDecisions(document), answers);
    expect(Object.keys(result.current)).toEqual(["fork-prs"]);
    expect(Object.keys(result.reopened).sort()).toEqual([
      "no-fk",
      "runs-as-clicker",
    ]);
    // The change request that the update answers asks for a verdict.
    expect(Object.keys(result.feedback)).toEqual(["no-fk"]);

    // A skip judged nothing, so changed code leaves the decision open.
    const skipped = reviewAnswers(document, reviewDecisions(document), {
      ...answers,
      "runs-as-clicker": { ...answers["runs-as-clicker"]!, value: "skip" },
    });
    expect(Object.keys(skipped.current)).toEqual(["fork-prs"]);
    expect(Object.keys(skipped.reopened)).toEqual(["no-fk"]);
  });

  it("lists what changed since the reviewer last answered", () => {
    const seen = lastSeenRank(document, answers);
    expect(seen).toBe(0);
    const chapters = walkthroughChapters(document);
    expect(
      changeSummary(document, seen)?.chapters.map((entry) => [
        chapters[entry.index]?.id,
        entry.added,
      ]),
    ).toEqual([
      ["versions-table", false],
      ["start-flow", false],
      ["dashboard-page", true],
    ]);
    // Answers on the update itself do not hide what changed.
    expect(
      lastSeenRank(document, {
        ...answers,
        "fork-prs": { ...answers["fork-prs"]!, versionId: document.versionId },
      }),
    ).toBe(0);
    expect(changeSummary(document, 1)).toBeUndefined();
  });
});
