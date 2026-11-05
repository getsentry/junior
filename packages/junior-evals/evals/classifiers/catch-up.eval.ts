import { describeEval } from "vitest-evals";
import { catchUpEvals } from "../../src/catch-up-harness";

const READER = { email: "dana@example.com", name: "Dana Reader" };

const OPENED_BRIEF = {
  summary: "Junior opened PR #12 to fix the Safari login bug.",
  intent: "Fix the Safari login bug.",
  outcome: { status: "in_progress" as const, text: "PR #12 is open." },
  decisions: [],
};

describeEval("Conversation Catch-Up", catchUpEvals, (it) => {
  it("when a row asks the reader to review, it adds a Needs you line", async ({
    run,
  }) => {
    await run({
      brief: OPENED_BRIEF,
      expectNeedsYou: true,
      reader: READER,
      rows: [
        {
          author: "Sam Lead",
          role: "user",
          text: "CI is red on Safari again. Can you take another pass?",
        },
        {
          role: "assistant",
          text: "I pushed a fix for the Safari cookie path to PR #12. CI passes now.",
        },
        {
          author: "Sam Lead",
          role: "user",
          text: "Thanks. Dana Reader, can you review PR #12 before the release cut?",
        },
      ],
    });
  });

  it("when nothing waits on the reader, it adds no Needs you line", async ({
    run,
  }) => {
    await run({
      brief: OPENED_BRIEF,
      expectNeedsYou: false,
      reader: READER,
      rows: [
        {
          author: "Sam Lead",
          role: "user",
          text: "Can you add a test for the Safari cookie path?",
        },
        {
          role: "assistant",
          text: "I added a test for the Safari cookie path to PR #12. CI passes.",
        },
        { author: "Sam Lead", role: "user", text: "Great, I'll review it." },
      ],
    });
  });

  it("when the code change is only open, it does not say it merged", async ({
    run,
  }) => {
    await run({
      brief: OPENED_BRIEF,
      forbidden: ["merged", "deployed", "released"],
      reader: READER,
      rows: [
        {
          author: "Sam Lead",
          role: "user",
          text: "Ship it once CI is green.",
        },
        {
          role: "assistant",
          text: "CI is green on PR #12. It is ready to merge, but I cannot merge it myself.",
        },
      ],
    });
  });
});
