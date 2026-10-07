import { describe, expect } from "vitest";
import { heartbeat, mention, reply } from "@junior-evals/fixture/inputs";
import {
  insertCredential,
  insertScheduledAutomation,
  slackChannel,
} from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test, type Conversation } from "@junior-evals/fixture/test";

/** The connected Sentry account of the default Slack person. */
const sentryCredential = {
  accessToken: "eval-sentry-access-token",
  provider: "sentry",
  refreshToken: "eval-sentry-refresh-token",
  scope:
    "alerts:write event:write member:read org:read project:releases project:write team:write",
};

/** Completed Sentry CLI commands that list the issues of getsentry. */
function issueListCommands(conversation: Conversation) {
  return completedToolCalls("bash", conversation).filter((call) =>
    /\bsentry\s+(issue list|api organizations\/getsentry\/issues\/)/.test(
      String((call.input as { command?: unknown } | undefined)?.command),
    ),
  );
}

describe("Sentry Skill Workflows", () => {
  test("when a Sentry request follows a generic first turn, use the Sentry skill and CLI", async ({
    run,
  }) => {
    await insertCredential(sentryCredential);

    const conversation = await run(
      mention("what's up with the latest Sentry issues in getsentry?"),
      {
        history: [mention("are you working"), reply("Yes—I'm working.")],
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply reports latest Sentry issue data for getsentry, including `JUNIOR-1`, `Eval issue`, or the issue permalink.",
        ],
        fail: [
          "Do not claim no skills, MCP tools, or Sentry tools are configured.",
          "Do not tell the user to manually open Sentry, run sentry-cli themselves, or provide an auth token.",
          "Do not ask the user to reconnect Sentry when the issue list is available.",
        ],
      }),
    );

    expect(
      completedToolCalls("loadSkill", conversation).map(
        (call) => (call.input as { skill_name?: unknown }).skill_name,
      ),
    ).toContain("sentry");
    expect(issueListCommands(conversation)).not.toHaveLength(0);
  });

  test("when creator-bound scheduled Sentry work becomes due, use the creator's account", async ({
    run,
  }) => {
    await insertCredential(sentryCredential);
    await insertScheduledAutomation({
      credentialMode: "creator",
      destination: slackChannel(),
      due: true,
      task: "Query Sentry for the latest unresolved issues in the getsentry organization and post a short digest with issue details.",
    });

    const digest = await run(heartbeat());
    await expect(digest).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The delivered scheduled-automation message reports Sentry issue data for getsentry, including `JUNIOR-1`, `Eval issue`, or the issue permalink.",
          "The scheduled run uses the available connected Sentry account without asking the user to authorize, reconnect, or provide a token.",
        ],
        fail: [
          "Do not ask the user to reconnect Sentry or provide an auth token.",
          "Do not claim that connected credentials are unavailable.",
          "Do not merely confirm that the recurring task exists.",
        ],
      }),
    );

    expect(issueListCommands(digest)).not.toHaveLength(0);
  });

  test("when creator-bound scheduled Sentry work becomes due without a connected account, do not ask the channel to connect it", async ({
    run,
  }) => {
    await insertScheduledAutomation({
      credentialMode: "creator",
      destination: slackChannel(),
      due: true,
      task: "Query Sentry for the latest unresolved issues in the getsentry organization and post a short digest with issue details.",
    });

    const digest = await run(heartbeat());

    // Nobody can connect Sentry during the run. The run does not wait for
    // authorization, and the channel gets no question, link, or apology.
    // When the run blocks, only its creator gets the blocked notice, in a
    // direct message.
    expect(
      digest.replies.filter(
        (posted) => !/^Your automation \*.+\* is blocked\./.test(posted.text),
      ),
    ).toEqual([]);
    expect(digest.turns.map((turn) => turn.status)).not.toContain("started");
  });
});
