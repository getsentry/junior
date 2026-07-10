import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";

describeEval("Skill Invocation Control", slackEvals, (it) => {
  const skillDirs = ["fixtures/skills"];

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

  it("loads a user-callable skill when the user explicitly names it", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: skillDirs },
      initialEvents: [
        mention(
          "Use the weather-lookup skill to check the weather in San Francisco.",
        ),
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
});
