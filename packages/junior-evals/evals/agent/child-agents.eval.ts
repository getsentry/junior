import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("Child Agent Results", () => {
  test("when a child agent uses its turn budget, report its progress instead of a failure", async ({
    agent,
  }) => {
    // Three tool calls stand in for a spent budget. Past the limit, Junior
    // blocks the next tool call and asks the child to reply with its progress.
    const { run } = await agent({
      limits: { maxToolCallsPerTurn: 3 },
    });
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Call systemTime five times, one call per step. Then reply with how many of the calls returned a time." When its result arrives, tell me what the child agent reported.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The last reply says the child agent stopped before all five calls ran, and it gives the number of calls that ran.",
        ],
        fail: ["The last reply says the child agent failed with an error."],
      }),
    );
  });

  test("when a reply only says a child agent took the work, mark it as progress, and not the result", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Call systemTime once and reply with the UTC time." Tell me once it has started, then tell me the time it reports.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    const handoff = conversation.turns.find((turn) =>
      turn.toolCalls.some((call) => call.name === "spawnAgent"),
    );
    expect(
      handoff?.toolCalls.some((call) => call.name === "markProgressReply"),
    ).toBe(true);
    expect(handoff?.replies.length).toBeGreaterThan(0);
    expect(handoff?.replies.map((reply) => reply.progress)).toEqual(
      handoff?.replies.map(() => true),
    );
    // The result is what the person waits for, so it notifies.
    expect(conversation.replies.at(-1)?.progress).toBeUndefined();
    expect(conversation.replies.at(-1)?.text).toMatch(/\d{1,2}:\d{2}/);
  });

  test("when a reply answers the request directly, do not mark it as progress", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC?"),
    );

    expect(completedToolCalls("markProgressReply", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
    expect(conversation.replies[0]?.progress).toBeUndefined();
  });
});
