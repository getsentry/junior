import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../helpers";

describeEval("Sentry Skill Workflows", slackEvals, (it) => {
  it("when listing Sentry organizations, report accessible organizations", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        credential_providers: ["sentry"],
        plugin_packages: ["@sentry/junior-sentry"],
      },
      events: [mention("List the Sentry organizations I can access.")],
      criteria: rubric({
        contract:
          "The assistant reports accessible Sentry organizations instead of blocking on setup or stale instructions.",
        pass: [
          "The assistant reply includes `getsentry` or otherwise reports the accessible organization list.",
          "The assistant does not claim that organization listing is unavailable.",
        ],
        fail: [
          "Do not say the Sentry org query surface is unavailable.",
          "Do not ask the user to reconnect Sentry when the organization list is available.",
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
            /\bsentry\s+(org list|api organizations\/)/,
          ),
        }),
      ]),
    );
    expect(
      output.assistant_posts?.map((post) => post.text ?? "").join("\n") ?? "",
    ).toMatch(/\bgetsentry\b/i);
  });
});
