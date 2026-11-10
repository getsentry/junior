import { describe, expect, it } from "vitest";
import { walkthroughOutputSchema } from "@/chat/walkthroughs/schema";
import { findWalkthroughProblems } from "@/chat/walkthroughs/validate";

const refs = {
  hunks: new Map([
    ["h-fix", { lineCount: 4 }],
    ["h-retry", { lineCount: 2 }],
  ]),
  sourceIds: new Set(["sentry-issue"]),
  checkIds: new Set(["ci"]),
};

function output(overrides: Record<string, unknown> = {}) {
  return walkthroughOutputSchema.parse({
    title: "Long Tasks survive token expiry",
    intent: "Refresh the GitHub token on a 401 and try once more.",
    diagram: {
      nodes: [
        { id: "client", label: "Client", column: 0, row: 0 },
        { id: "api", label: "API", column: 1, row: 0 },
      ],
      edges: [{ id: "c-a", from: "client", to: "api" }],
    },
    chapters: [
      {
        id: "cause",
        type: "bug_fix",
        slot: "cause",
        caption: "Tokens expire after 8 hours.",
        body: "Every Task that runs longer fails.",
        view: { show: ["client", "api", "c-a"] },
        evidence: [
          { kind: "hunk", hunkId: "h-fix", lines: { start: 1, end: 4 } },
        ],
      },
    ],
    rootCause: "proven",
    notCovered: [{ hunkId: "h-retry", reason: "Retry count only." }],
    ...overrides,
  });
}

describe("findWalkthroughProblems", () => {
  it("accepts output where every reference resolves and every hunk is covered", () => {
    expect(findWalkthroughProblems(output(), refs)).toEqual([]);
  });

  it("reports hunks that the story skips without saying so", () => {
    expect(findWalkthroughProblems(output({ notCovered: [] }), refs)).toEqual([
      "Hunk h-retry is not cited and not in notCovered.",
    ]);
  });

  it("rejects a proven root cause that cites only prose", () => {
    const problems = findWalkthroughProblems(
      output({
        chapters: [
          {
            id: "cause",
            type: "bug_fix",
            slot: "cause",
            caption: "Tokens expire after 8 hours.",
            body: "Every Task that runs longer fails.",
            evidence: [
              {
                kind: "source",
                sourceId: "sentry-issue",
              },
            ],
          },
        ],
        notCovered: [
          { hunkId: "h-fix", reason: "Shown elsewhere." },
          { hunkId: "h-retry", reason: "Retry count only." },
        ],
      }),
      refs,
    );
    expect(problems).toEqual([
      'rootCause is "proven", but the cause chapter cites no hunk or check.',
    ]);
  });

  it("rejects a slot that the change type does not have", () => {
    const wrong = output({
      chapters: [
        {
          id: "cause",
          type: "migration",
          slot: "cause",
          caption: "Wrong slot.",
          body: "Prose.",
          evidence: [{ kind: "hunk", hunkId: "h-fix" }],
        },
      ],
      rootCause: undefined,
    });
    expect(findWalkthroughProblems(wrong, refs)).toEqual([
      "Chapter cause uses slot cause, which migration does not have.",
    ]);
  });
});
