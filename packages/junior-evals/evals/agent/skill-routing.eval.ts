import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Skill Invocation Control", slackEvals, (it) => {
  const skillDirs = ["fixtures/skills"];
  const browserSkillDirs = ["../junior-agent-browser/skills"];

  it("does not auto-select a user-callable skill even when contextually relevant", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: skillDirs },
      initialEvents: [
        mention("What's the weather like in San Francisco today?"),
      ],
      criteria: rubric({
        pass: [
          "The assistant does not return the weather-lookup skill's simulated report (72°F, partly cloudy, 8 mph NW).",
        ],
        fail: [
          "Do not return the simulated weather report from the weather-lookup skill.",
        ],
      }),
    });
  });

  it("injects a user-callable skill when the user explicitly names it", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: skillDirs },
      initialEvents: [
        mention("$weather-lookup check the weather in San Francisco."),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts a reply containing a weather report for San Francisco from the weather-lookup skill.",
          "The reply includes the simulated data: 72°F or 22°C.",
        ],
        fail: [
          "Do not refuse to load the weather-lookup skill when the user explicitly asks for it.",
        ],
      }),
    });

    expect(toolCalls(result.session)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "loadSkill",
          arguments: expect.objectContaining({
            skill_name: "weather-lookup",
          }),
        }),
      ]),
    );
  });

  it("auto-selects an available skill when contextually relevant", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: skillDirs },
      initialEvents: [
        mention(
          "Can you double-check what the source handbook says about capability support verification?",
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts an answer based on the source-handbook content.",
        ],
        fail: [
          "Do not answer with generic capability advice that omits the handbook's verification rule.",
          "Do not refuse the request when the handbook content is available.",
        ],
      }),
    });
  });

  it("auto-selects visual web QA for frontend verification", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: browserSkillDirs },
      initialEvents: [
        mention(
          "I changed the docs site's responsive navigation and dark theme. How would you verify it in the browser? Don't start yet—I'll send the preview URL next.",
        ),
      ],
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "loadSkill",
          arguments: expect.objectContaining({ skill_name: "visual-web-qa" }),
        }),
      ]),
    );
  });
});
