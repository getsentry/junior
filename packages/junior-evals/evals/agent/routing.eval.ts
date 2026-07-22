import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { mention, reasoningLevels, slackEvals } from "../../src/helpers";

describeEval("Agent Reasoning Routing", slackEvals, (it) => {
  it("when asked for a bounded code change, uses medium reasoning", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "Implement a small TypeScript function that normalizes a retry count to an integer from 0 through 5, and include one focused unit test. Keep the answer to a single code block; no repository inspection is needed.",
        ),
      ],
      requireSandboxReady: false,
    });

    expect(reasoningLevels(result)).toEqual(["medium"]);
  });

  it("when asked for difficult architecture diagnosis, uses high reasoning", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "Diagnose why a background worker might duplicate side effects during queue retries, then recommend an architecture and test strategy. Use only this description and keep the answer concise.",
        ),
      ],
      requireSandboxReady: false,
    });

    expect(reasoningLevels(result)).toEqual(["high"]);
  });

  it("when maximum depth is explicit, preserves xhigh reasoning", async ({
    run,
  }) => {
    const result = await run({
      initialEvents: [
        mention(
          "Use the maximum available reasoning depth to decide whether a worker should acknowledge a queue message before or after its database transaction commits. Answer in one sentence.",
        ),
      ],
      requireSandboxReady: false,
    });

    expect(reasoningLevels(result)).toEqual(["xhigh"]);
  });
});
