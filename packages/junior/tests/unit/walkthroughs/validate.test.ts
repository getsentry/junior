import { describe, expect, it } from "vitest";
import { walkthroughOutputSchema } from "@/chat/walkthroughs/schema";
import { findWalkthroughProblems } from "@/chat/walkthroughs/validate";

const lockFile = "src/run-lock.ts";
const retryFile = "src/retry.ts";

const refs = {
  files: [
    {
      pr: 3150,
      path: lockFile,
      hunks: [
        {
          head: { start: 20, end: 26 },
          base: { start: 20, end: 25 },
        },
      ],
    },
    { pr: 3150, path: retryFile, hunks: [{ head: { start: 1, end: 3 } }] },
  ],
  sourceIds: new Set(["sentry-issue"]),
  checkIds: new Set(["ci"]),
};

function causeChapter(evidence: unknown[], body = "Every run fails [1].") {
  return {
    id: "cause",
    type: "bug_fix",
    slot: "cause",
    caption: "Each deployment takes its own lock.",
    body,
    evidence,
  };
}

function output(overrides: Record<string, unknown> = {}) {
  return walkthroughOutputSchema.parse({
    title: "Automations run once per tick",
    intent: "This PR fixes a bug where an automation ran twice during deploys.",
    diagram: {
      nodes: [
        { id: "scheduler", label: "Scheduler", column: 0, row: 0 },
        { id: "lock", label: "Run lock", column: 1, row: 0 },
      ],
      edges: [{ id: "s-l", from: "scheduler", to: "lock" }],
    },
    chapters: [
      causeChapter([
        { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
      ]),
    ],
    notCovered: [{ pr: 3150, path: retryFile, reason: "Retry count only." }],
    ...overrides,
  });
}

describe("findWalkthroughProblems", () => {
  it("accepts output where every citation resolves and every hunk is covered", () => {
    expect(findWalkthroughProblems(output(), refs)).toEqual([]);
  });

  it("reports hunks that the story skips without saying so", () => {
    expect(findWalkthroughProblems(output({ notCovered: [] }), refs)).toEqual([
      "src/retry.ts lines 1-3 (head) in PR #3150 are not cited, and the file is not in notCovered.",
    ]);
  });

  it("rejects code citations outside the diff", () => {
    const problems = findWalkthroughProblems(
      output({
        chapters: [
          causeChapter(
            [
              { kind: "code", pr: 3150, path: lockFile, start: 21, end: 30 },
              {
                kind: "code",
                pr: 3150,
                path: "src/other.ts",
                start: 1,
                end: 2,
              },
              {
                kind: "code",
                pr: 3150,
                path: retryFile,
                side: "base",
                start: 1,
                end: 1,
              },
            ],
            "Every run fails [1] [2] [3].",
          ),
        ],
      }),
      refs,
    );
    expect(problems).toEqual([
      "src/run-lock.ts lines 21-30 (head) in PR #3150: the range is not inside one diff hunk.",
      "src/other.ts lines 1-2 (head) in PR #3150: the file is not in the PR diff.",
      "src/retry.ts lines 1-1 (base) in PR #3150: the range is not inside one diff hunk.",
    ]);
  });

  it("covers removed code cited on the base side", () => {
    const problems = findWalkthroughProblems(
      output({
        chapters: [
          causeChapter([
            {
              kind: "code",
              pr: 3150,
              path: lockFile,
              side: "base",
              start: 22,
              end: 22,
            },
          ]),
        ],
      }),
      refs,
    );
    expect(problems).toEqual([]);
  });

  it("rejects a cause chapter that cites only prose", () => {
    const problems = findWalkthroughProblems(
      output({
        chapters: [
          causeChapter([{ kind: "source", sourceId: "sentry-issue" }]),
        ],
        notCovered: [
          { pr: 3150, path: lockFile, reason: "Shown elsewhere." },
          { pr: 3150, path: retryFile, reason: "Retry count only." },
        ],
      }),
      refs,
    );
    expect(problems).toEqual(["The cause chapter cites no code or check."]);
  });

  it("rejects prose that cites missing evidence or skips evidence", () => {
    const uncited = output({
      chapters: [
        causeChapter(
          [{ kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 }],
          "Every run fails [2].",
        ),
      ],
    });
    expect(findWalkthroughProblems(uncited, refs)).toEqual([
      "cause cites [2], which is not in its evidence.",
      "cause never cites evidence [1].",
    ]);
  });

  it("rejects a slot that the change type does not have", () => {
    const wrong = output({
      chapters: [
        {
          ...causeChapter([
            { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
          ]),
          type: "migration",
        },
      ],
    });
    expect(findWalkthroughProblems(wrong, refs)).toEqual([
      "Chapter cause uses slot cause, which migration does not have.",
    ]);
  });
});
