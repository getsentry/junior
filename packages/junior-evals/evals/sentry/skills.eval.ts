import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { beforeAll, expect } from "vitest";
import {
  mention,
  rubric,
  scheduledTaskDue,
  slackEvals,
  threadMessage,
} from "../../src/helpers";
import { warmSandboxSnapshot } from "../../src/snapshot-warmup";

const SNAPSHOT_WARMUP_TIMEOUT_MS = 10 * 60 * 1000;

describeEval("Sentry Skill Workflows", slackEvals, (it) => {
  // Deployments warm plugin runtime dependencies before serving turns. Keep
  // that one-time setup cost outside the behavioral response-time budget.
  beforeAll(async () => {
    await warmSandboxSnapshot(["@sentry/junior-sentry"]);
  }, SNAPSHOT_WARMUP_TIMEOUT_MS);

  const followUpThread = {
    id: "thread-sentry-follow-up",
    channel_id: "CSENTRYFOLLOWUP",
    thread_ts: "17000000.1501",
  };

  it("when a Sentry request follows a generic first turn, use the Sentry skill and CLI", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        credential_providers: ["sentry"],
        plugin_packages: ["@sentry/junior-sentry"],
        reply_texts: ["Yes—I'm working."],
      },
      initialEvents: [mention("are you working", { thread: followUpThread })],
      events: [
        threadMessage("what's up with the latest Sentry issues in getsentry?", {
          thread: followUpThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "The second reply reports latest Sentry issue data for getsentry, including `JUNIOR-1`, `Eval issue`, or the issue permalink.",
        ],
        fail: [
          "Do not claim no skills, MCP tools, or Sentry tools are configured.",
          "Do not tell the user to manually open Sentry, run sentry-cli themselves, or provide an auth token.",
          "Do not ask the user to reconnect Sentry when the issue list is available.",
        ],
      }),
    });
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "loadSkill",
          arguments: expect.objectContaining({ skill_name: "sentry" }),
        }),
        expect.objectContaining({
          name: "bash",
          arguments: expect.objectContaining({
            command: expect.stringMatching(
              /\bsentry\s+(issue list|api organizations\/getsentry\/issues\/)/,
            ),
          }),
        }),
      ]),
    );
    expect(
      assistantMessages(result.session)
        .map((message) =>
          typeof message.content === "string" ? message.content : "",
        )
        .join("\n"),
    ).toMatch(/\b(JUNIOR-1|Eval issue|getsentry)\b/i);
  });

  it("when creator-bound scheduled Sentry work becomes due, use the creator's account", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        credential_providers: ["sentry"],
        plugin_packages: ["@sentry/junior-sentry"],
      },
      initialEvents: [
        scheduledTaskDue(
          "Query Sentry for the latest unresolved issues in the getsentry organization and post a short digest with issue details.",
          {
            credential_mode: "creator",
            recurrence: "weekly",
            schedule: "Weekly on Monday at 9am Pacific",
            schedule_kind: "recurring",
            timezone: "America/Los_Angeles",
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The delivered scheduled-task message reports Sentry issue data for getsentry, including `JUNIOR-1`, `Eval issue`, or the issue permalink.",
          "The scheduled run uses the available connected Sentry account without asking the user to authorize, reconnect, or provide a token.",
        ],
        fail: [
          "Do not ask the user to reconnect Sentry or provide an auth token.",
          "Do not claim that connected credentials are unavailable.",
          "Do not merely confirm that the recurring task exists.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bash",
          arguments: expect.objectContaining({
            command: expect.stringMatching(
              /\bsentry\s+(issue list|api organizations\/getsentry\/issues\/)/,
            ),
          }),
        }),
      ]),
    );
  });
});
