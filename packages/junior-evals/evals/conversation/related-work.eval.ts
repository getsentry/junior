import { describe, expect } from "vitest";
import { person, slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

/**
 * Related work on a person's first request. Before it starts, the agent sees
 * open Conversations that may cover the same work, and it points the person
 * to one only when it is the same work.
 */

const MAYA = person("UMAYA", "Maya");
const SAM = person("USAM", "Sam");

const MAYA_REQUEST =
  "I'm moving our billing cron jobs off Heroku Scheduler onto GitHub Actions this week. Can you draft the migration steps? I'll own the rollout.";

describe("Related Work", () => {
  test("when another open conversation already covers the same work, point the person to it", async ({
    run,
  }) => {
    await run(slackMention(MAYA_REQUEST, { author: MAYA }));

    const conversation = await run(
      slackMention(
        "Can you help me migrate the billing cron jobs from Heroku Scheduler to GitHub Actions?",
        { author: SAM },
      ),
    );

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant tells Sam that another conversation already covers moving the billing cron jobs to GitHub Actions, or that someone is already working on it.",
          "The assistant gives Sam a way to find that work, such as a link, or offers to continue there or work here anyway.",
        ],
        fail: ["Do not answer as if no one else is working on the migration."],
      }),
    );
  });

  test("when another open conversation is about something else, do not mention it", async ({
    run,
  }) => {
    await run(slackMention(MAYA_REQUEST, { author: MAYA }));

    const conversation = await run(
      slackMention(
        "What are three good names for a Slack channel for the design team offsite?",
        { author: SAM },
      ),
    );

    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The assistant suggests names for the offsite channel."],
        fail: [
          "Do not mention the billing cron migration, Heroku, GitHub Actions, or another conversation.",
        ],
      }),
    );
  });
});
