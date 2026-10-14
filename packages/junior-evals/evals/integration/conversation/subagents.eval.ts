import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
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

  test("when a child agent is missing input, it reports the block and the parent asks for it", async ({
    agent,
  }) => {
    const { run } = await agent({ experimental: { subagents: true } });
    const requestedTools: string[] = [];
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Reply with the deploy region that the user chose. The region is not in this task." When its result arrives, tell me what happened.',
      ),
      {
        onProgress: (progress) => {
          if (progress.type === "tool_request") {
            requestedTools.push(progress.name);
          }
        },
      },
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // Only the child agent has reportBlocked.
    expect(requestedTools).toContain("reportBlocked");
    expect(conversation.turns).toHaveLength(2);
    const resultTurn = conversation.turns[1];
    expect(resultTurn?.status).toBe("succeeded");
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The last reply says the child agent could not finish because it does not know the deploy region.",
          "The last reply asks the user for the region or says that the user must give it.",
        ],
        fail: ["Do not name a deploy region or say the task is done."],
      }),
    );
  });

  test("when a child agent is no longer needed, stop it without a result turn", async ({
    agent,
  }) => {
    const { run } = await agent({ experimental: { subagents: true } });
    // The child agent and the parent run at the same time. A replayed model
    // response comes back at once, so without this order the child can make
    // more model requests before the stop reaches it than it made in the
    // recording run. The child gets its first response, and then it waits
    // until stopAgent ran and the worker checked for the stop.
    let childAsked!: () => void;
    const childAskedOnce = new Promise<void>((resolve) => {
      childAsked = resolve;
    });
    let stopRan!: () => void;
    const stopRanOnce = new Promise<void>((resolve) => {
      stopRan = resolve;
    });
    let stopRequested = false;
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent named "scout" with the task "Use webSearch to research maple syrup, then write a detailed 2,000-word history of it." The work is no longer needed, so use stopAgent to stop it right away. Then reply here with only the word STOPPED.',
      ),
      {
        onProgress: async (progress) => {
          if (
            (progress.type === "model_request" && stopRequested) ||
            progress.type === "reply"
          ) {
            stopRan();
          } else if (progress.type === "tool_request") {
            if (progress.name === "stopAgent") {
              await childAskedOnce;
              stopRequested = true;
            } else if (progress.name === "webSearch") {
              childAsked();
              await stopRanOnce;
              await new Promise((resolve) => setTimeout(resolve, 1_500));
            }
          }
        },
      },
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    expect(completedToolCalls("stopAgent", conversation)).toHaveLength(1);
    // A stopped child agent sends no result, so no later Turn starts.
    expect(conversation.turns).toHaveLength(1);
    expect(conversation.turns[0]?.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("STOPPED"),
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
