import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { toolCallsOf } from "@junior-evals/fixture/results";
import { test, type Conversation } from "@junior-evals/fixture/test";

/** Names of the skills that the agent loaded with `loadSkill`. */
function loadedSkills(conversation: Conversation): unknown[] {
  return toolCallsOf("loadSkill", conversation).map(
    (call) => (call.input as { skill_name?: unknown } | undefined)?.skill_name,
  );
}

describe("Skill Invocation Control", () => {
  test("injects a user-callable skill when the user explicitly names it", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("$weather-lookup check the weather in San Francisco."),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts a reply containing a weather report for San Francisco from the weather-lookup skill.",
          "The reply includes the simulated data: 72°F or 22°C.",
        ],
        fail: [
          "Do not refuse to load the weather-lookup skill when the user explicitly asks for it.",
        ],
      }),
    );

    // The skill name already put the skill in the turn.
    expect(loadedSkills(conversation)).not.toContain("weather-lookup");
  });

  test("auto-selects an available skill when contextually relevant", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Can you double-check what the source handbook says about capability support verification?",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts an answer based on the source-handbook content.",
        ],
        fail: [
          "Do not answer with generic capability advice that omits the handbook's verification rule.",
          "Do not refuse the request when the handbook content is available.",
        ],
      }),
    );
  });

  test("auto-selects visual web QA for frontend verification", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "I changed the docs site's responsive navigation and dark theme. How would you verify it in the browser? Don't start yet—I'll send the preview URL next.",
      ),
    );

    expect(loadedSkills(conversation)).toContain("visual-web-qa");
  });
});
