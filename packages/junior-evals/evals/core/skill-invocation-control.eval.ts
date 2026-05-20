import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals } from "../helpers";

describeEval("Skill Invocation Control", slackEvals, (it) => {
  const skillDirs = ["evals/fixtures/skills"];

  it("does not auto-select a user-callable skill even when contextually relevant", async ({
    run,
  }) => {
    await run({
      overrides: { skill_dirs: skillDirs },
      events: [mention("What's the weather like in San Francisco today?")],
      criteria: rubric({
        contract:
          "A skill with disable-model-invocation must not be loaded by the model based on topic relevance alone.",
        pass: [
          "The assistant does not invoke `loadSkill` with `skill_name` set to `weather-lookup`.",
          "The assistant posts a reply that does not contain the weather-lookup simulated data (72°F, partly cloudy, 8 mph NW).",
        ],
        allow: [
          "The assistant may say it cannot check real weather or offer general knowledge.",
          "The assistant may mention that a weather skill exists but explain it was not invoked.",
        ],
        fail: [
          "Do not load the weather-lookup skill automatically.",
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
      events: [
        mention(
          "Use the weather-lookup skill to check the weather in San Francisco.",
        ),
      ],
      criteria: rubric({
        contract:
          "A skill with disable-model-invocation is loaded when the user explicitly references it by name in their message.",
        pass: [
          "observed_tool_invocations includes a `loadSkill` invocation with `skill_name` set to `weather-lookup`.",
          "The assistant posts a reply containing a weather report for San Francisco.",
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
      events: [
        mention(
          "Can you double-check what the source handbook says about capability support verification?",
        ),
      ],
      criteria: rubric({
        contract:
          "A normal available skill (without disable-model-invocation) is auto-selected when the request matches its description.",
        pass: [
          "observed_tool_invocations includes a `loadSkill` invocation with `skill_name` set to `source-handbook`.",
          "The assistant posts a reply based on the source handbook content.",
        ],
        fail: [
          "Do not answer from memory without loading the source-handbook skill.",
          "Do not refuse to load the skill when the topic clearly matches.",
        ],
      }),
    });
  });
});
