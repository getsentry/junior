import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals, threadMessage } from "../helpers";

describeEval("Sentry Skill Workflows", slackEvals, (it) => {
  const followUpThread = {
    id: "thread-sentry-follow-up",
    channel_id: "C-sentry-follow-up",
    thread_ts: "17000000.sentry-follow-up",
  };

  it("when a Sentry request follows a generic first turn, use the Sentry skill and CLI", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        credential_providers: ["sentry"],
        plugin_packages: ["@sentry/junior-sentry"],
      },
      events: [
        mention("are you working", { thread: followUpThread }),
        threadMessage("what's up with the latest Sentry issues in getsentry?", {
          thread: followUpThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        contract:
          "A Sentry follow-up in an existing Slack thread still has skill context and queries Sentry instead of claiming tools are unavailable.",
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
    const output = (result.output ?? {}) as {
      assistant_posts?: Array<{ text?: string }>;
      observed_tool_invocations?: Array<{
        tool?: string;
        skill_name?: string;
        bash_command?: string;
      }>;
    };
    expect(output.observed_tool_invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "loadSkill", skill_name: "sentry" }),
        expect.objectContaining({
          tool: "bash",
          bash_command: expect.stringMatching(
            /\bsentry\s+(issue list|api organizations\/getsentry\/issues\/)/,
          ),
        }),
      ]),
    );
    expect(
      output.assistant_posts?.map((post) => post.text ?? "").join("\n") ?? "",
    ).toMatch(/\b(JUNIOR-1|Eval issue|getsentry)\b/i);
  });
});
