import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Skills", slackEvals, (it) => {
  const incidentBriefThread = {
    id: "thread-incident-brief-repeat",
    channel_id: "CINCIDENTBRIEF",
    thread_ts: "17000000.1101",
  };

  it("when an explicit skill runs twice in one thread, keep its replies ordered", async ({
    run,
  }) => {
    const result = await run({
      overrides: { skill_dirs: ["fixtures/skills"] },
      initialEvents: [
        mention("/incident-brief Checkout latency", {
          thread: incidentBriefThread,
        }),
      ],
      events: [
        threadMessage("/incident-brief Search errors", {
          thread: incidentBriefThread,
          is_mention: true,
        }),
      ],
      criteria: rubric({
        pass: [
          "Across two turns in one thread, the assistant replies about Checkout latency first, then Search errors.",
          "Each reply contains the requested incident name, Investigating status, and On-call owner.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });
});
