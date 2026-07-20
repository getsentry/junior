import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Skills", slackEvals, (it) => {
  it("when the candidate brief command runs, return one candidate brief reply", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      initialEvents: [mention("/candidate-brief David Cramer")],
      criteria: rubric({
        pass: [
          "The reply is a candidate brief for David Cramer with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  const candidateBriefThread = {
    id: "thread-candidate-brief-repeat",
    channel_id: "CCANDIDATEBRIEF",
    thread_ts: "17000000.1101",
  };

  it("when the candidate brief command runs twice in one thread, keep the replies ordered", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      initialEvents: [
        mention("/candidate-brief Alice Example", {
          thread: candidateBriefThread,
        }),
      ],
      events: [
        threadMessage("/candidate-brief Bob Example", {
          thread: candidateBriefThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "Across two turns in one thread, the assistant replies about Alice first, then Bob.",
          "Each reply addresses the requested candidate by name.",
          "Each reply provides a brief with role, team, and location-style details.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });

  it("when the working-directory command runs, return one file-list reply", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      initialEvents: [mention("/list-working-directory")],
      criteria: rubric({
        pass: [
          "The reply includes a file-list section such as 'Working directory files:'.",
        ],
        fail: ["Do not include sandbox setup failure text."],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
