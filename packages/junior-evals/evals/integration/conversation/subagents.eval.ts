import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// A child agent result starts a later Turn in the parent thread. These tests
// check that the thread gets exactly one such Turn for each child agent.
describe("Child Agents", () => {
  test("when a child agent finishes, report its result in a later turn", async ({
    agent,
  }) => {
    const { run } = await agent({ experimental: { subagents: true } });
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Reply with only the code word MAPLE-7." When its result arrives, post the code word here.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    expect(conversation.turns).toHaveLength(2);
    const resultTurn = conversation.turns[1];
    expect(resultTurn?.status).toBe("succeeded");
    expect(resultTurn?.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("MAPLE-7"),
    ]);
  });

  test("when a child agent starts its own child agent, report once after both finish", async ({
    agent,
  }) => {
    const { run } = await agent({
      experimental: { subagents: true },
      limits: { maxAgentDepth: 1 },
    });
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with this task: "Use spawnAgent to start one helper agent with the task \\"Reply with only the code word CEDAR-9.\\" When the helper\'s result arrives, reply with only that code word." When the child agent\'s result arrives, post the code word here.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // The first agent invocation of the child ends while its helper's result
    // is still open, so a later agent invocation of the child reports. The
    // parent gets that one report, not two.
    expect(conversation.turns).toHaveLength(2);
    const resultTurn = conversation.turns[1];
    expect(resultTurn?.status).toBe("succeeded");
    expect(resultTurn?.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("CEDAR-9"),
    ]);
  });
});
