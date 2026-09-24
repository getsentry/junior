import { describeEval } from "vitest-evals";
import { routerEvals } from "../../src/router-harness";

describeEval("Turn Router Reasoning Snapshots", routerEvals, (it) => {
  it("when the user only acknowledges the assistant, use no reasoning", async ({
    run,
  }) => {
    await run({
      expectedProfile: "standard",
      expectedReasoningLevel: "none",
      messageText: "thanks!",
    });
  });

  it("when the user asks for a fixed text transform, use low reasoning", async ({
    run,
  }) => {
    await run({
      expectedProfile: "standard",
      expectedReasoningLevel: "low",
      messageText: "alphabetize these words: pear, apple, banana",
    });
  });

  it("when the user asks for a current source-backed check, use medium reasoning", async ({
    run,
  }) => {
    await run({
      expectedProfile: "standard",
      expectedReasoningLevel: "medium",
      messageText:
        "check the Sentry status page and tell me if there is an active incident",
    });
  });

  it("when the user asks for a thorough strategy comparison, use high reasoning", async ({
    run,
  }) => {
    await run({
      expectedProfile: "standard",
      expectedReasoningLevel: "high",
      messageText:
        "be thorough: compare a big-bang launch, a customer beta, and a gradual rollout; analyze tradeoffs and risks, then recommend one",
    });
  });

  it("when the user asks for a multi-file code change, use xhigh reasoning", async ({
    run,
  }) => {
    await run({
      expectedProfile: "handoff",
      expectedReasoningLevel: "xhigh",
      messageText:
        "refactor the conversation delivery pipeline across the runtime and Slack provider, update the tests, and open a pull request",
    });
  });

  it("uses task descriptions even when profile names suggest the opposite", async ({
    run,
  }) => {
    await run({
      profiles: {
        standard: {
          modelId: "anthropic/claude-opus-5.5",
          description:
            "Use for implementation, code review, and architecture decisions. Avoid for routine lookups.",
        },
        handoff: {
          modelId: "openai/gpt-6-luna",
          description:
            "Use for routine lookups, short explanations, and status checks. Avoid for implementation and code review.",
        },
      },
      expectedProfile: "handoff",
      expectedReasoningLevel: "medium",
      messageText: "Check whether the latest deployment is ready.",
    });
  });

  it("when a short approval continues pending implementation, route the pending task", async ({
    run,
  }) => {
    await run({
      conversationContext: [
        "David: Can you implement the new provider flow across the runtime, add integration tests, and open a pull request?",
        "Junior: I can do that. Should I proceed?",
      ].join("\n"),
      expectedProfile: "handoff",
      expectedReasoningLevel: "xhigh",
      messageText: "go for it",
    });
  });
});
