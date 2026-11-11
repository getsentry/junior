import { describe, expect, it } from "vitest";
import { walkthroughOutputSchema } from "@/chat/walkthroughs/schema";
import { validateWalkthrough } from "@/chat/walkthroughs/validate";

const lockFile = "src/run-lock.ts";
const retryFile = "src/retry.ts";

const refs = {
  prs: new Set([3150]),
  files: [
    {
      pr: 3150,
      path: lockFile,
      hunks: [
        {
          head: { start: 20, end: 26 },
          base: { start: 20, end: 25 },
          lines: [],
        },
      ],
    },
    {
      pr: 3150,
      path: retryFile,
      hunks: [{ head: { start: 1, end: 3 }, lines: [] }],
    },
  ],
  contextFiles: new Map([["3150:src/scheduler.ts", "a\nb\nc\nd\n"]]),
  messageSeqs: new Set([12]),
  knownUrls: new Set(["https://sentry.io/issues/1/"]),
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
    diagrams: [
      {
        pr: 3150,
        nodes: [
          { id: "scheduler", label: "Scheduler" },
          { id: "lock", label: "Run lock" },
        ],
        edges: [{ id: "s-l", from: "scheduler", to: "lock" }],
      },
    ],
    chapters: [
      causeChapter([
        { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
      ]),
    ],
    not_covered: [{ pr: 3150, path: retryFile, reason: "Retry count only." }],
    ...overrides,
  });
}

describe("validateWalkthrough", () => {
  it("accepts output where every citation resolves and every hunk is covered", () => {
    expect(validateWalkthrough(output(), refs)).toEqual([]);
  });

  it("reports hunks that the story skips without saying so", () => {
    expect(validateWalkthrough(output({ not_covered: [] }), refs)).toEqual([
      "src/retry.ts lines 1-3 (head) in PR #3150 are not cited, and the file is not in not_covered.",
    ]);
  });

  it("rejects code citations that do not resolve", () => {
    const problems = validateWalkthrough(
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
                path: "src/scheduler.ts",
                start: 3,
                end: 5,
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
            "Every run fails [1] [2] [3] [4].",
          ),
        ],
      }),
      refs,
    );
    expect(problems).toEqual([
      "src/run-lock.ts lines 21-30 (head) in PR #3150: the file does not exist at the PR head commit.",
      "src/other.ts lines 1-2 (head) in PR #3150: the file does not exist at the PR head commit.",
      "src/scheduler.ts lines 3-5 (head) in PR #3150: the file has only 4 lines at the PR head commit.",
      "src/retry.ts lines 1-1 (base) in PR #3150: base-side ranges must be inside one diff hunk.",
    ]);
  });

  it("accepts head-side code outside the diff from a file read at the head commit", () => {
    const problems = validateWalkthrough(
      output({
        chapters: [
          causeChapter(
            [
              { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
              {
                kind: "code",
                pr: 3150,
                path: "src/scheduler.ts",
                start: 2,
                end: 4,
              },
            ],
            "Every run fails [1], and the scheduler still calls it [2].",
          ),
        ],
      }),
      refs,
    );
    expect(problems).toEqual([]);
  });

  it("rejects messages and links that Junior cannot resolve", () => {
    const problems = validateWalkthrough(
      output({
        chapters: [
          causeChapter(
            [
              { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
              { kind: "message", seq: 12 },
              { kind: "message", seq: 99 },
              {
                kind: "link",
                url: "https://example.com/made-up",
                label: "Made up",
              },
            ],
            "Every run fails [1] [2] [3] [4].",
          ),
        ],
      }),
      refs,
    );
    expect(problems).toEqual([
      "Message 99 is not in the source Conversation.",
      "Link https://example.com/made-up is not in a PR body or a cited message.",
    ]);
  });

  it("covers removed code cited on the base side", () => {
    const problems = validateWalkthrough(
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
    const problems = validateWalkthrough(
      output({
        chapters: [causeChapter([{ kind: "message", seq: 12 }])],
        not_covered: [
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
    expect(validateWalkthrough(uncited, refs)).toEqual([
      "cause cites [2], which is not in its evidence.",
      "cause never cites evidence [1].",
    ]);
  });

  it("rejects repeated captions, question decisions, and diagrams that do not fit the stack", () => {
    const evidence = [
      { kind: "code", pr: 3150, path: lockFile, start: 21, end: 23 },
    ];
    const problems = validateWalkthrough(
      output({
        diagrams: [
          { pr: 3150, nodes: [{ id: "lock", label: "Run lock" }], edges: [] },
          { pr: 3151, nodes: [{ id: "retry", label: "Retry" }], edges: [] },
        ],
        chapters: [
          {
            ...causeChapter(evidence),
            view: { pr: 3150, show: ["lock"] },
            decisions: [
              {
                id: "lock-ttl",
                claim: "Is a 30 second lock long enough?",
                origin: { kind: "assumed" },
              },
            ],
          },
          {
            ...causeChapter(evidence),
            id: "cause-again",
            view: { pr: 3152, show: ["retry"] },
          },
        ],
      }),
      refs,
    );
    expect(problems).toEqual([
      "A diagram is for PR #3151, which is not in the stack.",
      "Chapters cause and cause-again have the same caption. Make each caption unique.",
      "Decision lock-ttl is a question. Write the claim as a statement, and put the doubt in concern.",
      "Chapter cause-again shows the diagram for PR #3152, which has none.",
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
    expect(validateWalkthrough(wrong, refs)).toEqual([
      "Chapter cause uses slot cause, which migration does not have.",
    ]);
  });
});
