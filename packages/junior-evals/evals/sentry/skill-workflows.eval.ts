import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals, threadMessage } from "../../src/helpers";

describeEval("Sentry Skill Workflows", slackEvals, (it) => {
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
          "The first reply acknowledges it is available.",
          "The second reply reports latest Sentry issue data for getsentry, including `JUNIOR-1`, `Eval issue`, or the issue permalink.",
          "The assistant uses the Sentry skill/CLI path on the second turn rather than falling back to manual instructions.",
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
});
