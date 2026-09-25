import { describeEval } from "vitest-evals";
import { routerEvals } from "../../src/router-harness";

describeEval("Task-fit Profile Selection", routerEvals, (it) => {
  it("keeps a single-file code lookup on standard", async ({ run }) => {
    await run({
      expectedProfile: "standard",
      expectedReasoningLevel: "high",
      messageText:
        "Read package.json and tell me which command runs the unit tests. Do not change anything.",
    });
  });

  it("routes a code review to handoff", async ({ run }) => {
    await run({
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText:
        "Review the authentication changes in this pull request for correctness and security risks before we merge it.",
    });
  });

  it("routes investigation across systems to handoff", async ({ run }) => {
    await run({
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText:
        "Find why requests time out after yesterday's release. Compare the deployment changes, application traces, and database metrics to identify the cause.",
    });
  });

  it("keeps verification attached to unfinished implementation", async ({
    run,
  }) => {
    await run({
      conversationContext: [
        "User: Fix duplicate deliveries after a worker restart.",
        "Junior: I changed the retry logic, but have not run the regression tests yet.",
      ].join("\n"),
      expectedProfile: "handoff",
      expectedReasoningLevel: "high",
      messageText: "verify it before opening the PR",
    });
  });

  it("does not carry difficult work into a new routine request", async ({
    run,
  }) => {
    await run({
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
