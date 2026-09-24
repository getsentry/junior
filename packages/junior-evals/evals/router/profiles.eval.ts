import { describeEval } from "vitest-evals";
import type { ModelProfileConfig } from "@/chat/model-profile";
import { routerEvals } from "../../src/router-harness";

// Match the consumer app's Luna/Opus profile split. These cases test profile
// selection and fixed reasoning levels, not the models' task completion.
const profiles = {
  standard: {
    modelId: "openai/gpt-6-luna",
    description:
      "Use standard for lookups, explanations, summaries, routine tool use, and focused source checks, including reading a single code file. Use handoff instead for implementation, debugging, code review, architecture decisions, or research across several systems. A mention of code or use of tools alone does not require handoff.",
    reasoningLevel: "high",
  },
  handoff: {
    modelId: "anthropic/claude-opus-5.5",
    description:
      "Use handoff for implementation, debugging, code review, architecture decisions, and research across several systems. Keep this profile through implementation and verification of the same task. Use standard for a new routine request, not handoff merely because earlier work was difficult. A failed tool call or missing access alone does not require handoff.",
    reasoningLevel: "high",
  },
} satisfies Readonly<Record<string, ModelProfileConfig>>;

describeEval("Task-fit Profile Selection", routerEvals, (it) => {
  it("keeps a single-file code lookup on standard", async ({ run }) => {
    await run({
      profiles,
      fastModelId: "openai/gpt-5.6-luna",
      expectedProfile: "standard",
      expectedReasoningLevel: "high",
      messageText:
        "Read package.json and tell me which command runs the unit tests. Do not change anything.",
    });
  });

  it("routes a code review to handoff", async ({ run }) => {
    await run({
      profiles,
      fastModelId: "openai/gpt-5.6-luna",
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText:
        "Review the authentication changes in this pull request for correctness and security risks before we merge it.",
    });
  });

  it("routes investigation across systems to handoff", async ({ run }) => {
    await run({
      profiles,
      fastModelId: "openai/gpt-5.6-luna",
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText:
        "Find why requests time out after yesterday's release. Compare the deployment changes, application traces, and database metrics to identify the cause.",
    });
  });

  it("keeps an approval attached to pending implementation", async ({
    run,
  }) => {
    await run({
      profiles,
      fastModelId: "openai/gpt-5.6-luna",
      conversationContext: [
        "User: Add pagination to the endpoint and update its tests.",
        "Junior: The change needs an API update and a client update. Should I proceed?",
      ].join("\n"),
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText: "yes, do it",
    });
  });

  it("does not carry difficult work into a new routine request", async ({
    run,
  }) => {
    await run({
      profiles,
      fastModelId: "openai/gpt-5.6-luna",
      conversationContext: [
        "User: Fix the race in the task queue and add a regression test.",
        "Junior: The fix is complete, the tests passed, and the pull request is open.",
      ].join("\n"),
      expectedProfile: "standard",
      expectedReasoningLevel: "high",
      messageText:
        "Separate question: check the public status page and tell me whether there is an active incident.",
    });
  });
});
