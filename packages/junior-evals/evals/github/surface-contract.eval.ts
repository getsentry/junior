import { describeEval } from "vitest-evals";
import { githubMention, rubric, slackEvals } from "../helpers";

describeEval("GitHub Surface Contract", slackEvals, (it) => {
  it("when replying from a GitHub mention, stay on the GitHub comment surface", async ({
    run,
  }) => {
    await run({
      events: [
        githubMention(
          "The failing check says `Cannot find module '@/chat/slack/tools'`. Summarize the likely cleanup in two concise bullets. Reply here in GitHub.",
        ),
      ],
      criteria: rubric({
        contract:
          "A GitHub mention produces a normal GitHub comment reply without Slack-only side effects or formatting.",
        pass: [
          "assistant_posts contains exactly one reply.",
          "The reply is useful GitHub-flavored Markdown for the requested summary.",
          "channel_posts, reactions, and canvases are empty.",
          "slack_metadata.assistant_status_pending is false.",
        ],
        fail: [
          "Do not include Slack mention or channel markup such as `<@...>` or `<#...>`.",
          "Do not claim to post a Slack message, Slack reaction, or Slack canvas.",
          "Do not ask the user to retry from Slack for this normal non-auth reply.",
        ],
      }),
    });
  });
});
