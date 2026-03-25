import { describe } from "vitest";
import { mention, slackEval, threadMessage } from "../helpers";

describe("Conversational Evals: Skill Infrastructure", () => {
  slackEval("skills: candidate brief command", {
    overrides: { skill_dirs: ["evals/fixtures/skills"] },
    events: [mention("/candidate-brief David Cramer")],
    criteria:
      "The assistant posts exactly one reply for David Cramer. The reply is a candidate brief with role/team/location-style details and does not include sandbox setup failure text.",
  });

  const candidateBriefThread = {
    id: "thread-candidate-brief-repeat",
    channel_id: "C-candidate-brief",
    thread_ts: "17000000.candidate-brief",
  };

  slackEval("skills: candidate brief repeated in one thread", {
    overrides: { skill_dirs: ["evals/fixtures/skills"] },
    events: [
      mention("/candidate-brief Alice Example", {
        thread: candidateBriefThread,
      }),
      threadMessage("/candidate-brief Bob Example", {
        thread: candidateBriefThread,
        is_mention: true,
      }),
    ],
    criteria:
      "Across two turns in one thread, the assistant posts exactly two replies in-order (Alice then Bob). Each reply addresses the requested candidate by name and provides a brief with role/team/location-style details. Do not include sandbox setup failure text.",
  });

  slackEval("skills: list working directory", {
    overrides: { skill_dirs: ["evals/fixtures/skills"] },
    events: [mention("/list-working-directory")],
    criteria:
      "The assistant posts exactly one working-directory listing reply that includes a file-list section (for example 'Working directory files:') and does not include sandbox setup failure text.",
  });
});
