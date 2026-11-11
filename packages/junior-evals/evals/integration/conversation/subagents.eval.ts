import { describe, expect } from "vitest";
import { reply, slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test, type CallOptions } from "@junior-evals/fixture/test";

/** Record the name of each tool that the parent or a child agent requests. */
function recordToolRequests(names: string[]): CallOptions["onProgress"] {
  return (progress) => {
    if (progress.type === "tool_request") {
      names.push(progress.name);
    }
  };
}

// A child agent result starts a later Turn in the parent thread. These tests
// check that the thread gets exactly one such Turn for each child agent.
describe("Child Agents", () => {
  test("when a child agent finishes, report its result in a later turn", async ({
    agent,
  }) => {
    const { run } = await agent();
    const requestedTools: string[] = [];
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Reply with only the code word MAPLE-7." When its result arrives, post the code word here.',
      ),
      { onProgress: recordToolRequests(requestedTools) },
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // Only the child's `reply` reaches the parent.
    expect(requestedTools).toContain("reply");
    expect(conversation.turns).toHaveLength(2);
    // A status that only says the child started would notify people twice.
    expect(conversation.turns[0]?.replies).toEqual([]);
    const resultTurn = conversation.turns[1];
    expect(resultTurn?.status).toBe("succeeded");
    expect(resultTurn?.replies.map((reply) => reply.text)).toEqual([
      expect.stringContaining("MAPLE-7"),
    ]);
  });

  test("when the parent delegates, the task carries facts from earlier thread messages", async ({
    agent,
  }) => {
    const { run } = await agent();
    const conversation = await run(
      slackMention(
        "Hand that typo fix plan off to a child agent and post the plan here. No repo changes.",
      ),
      {
        history: [
          slackMention(
            'I already checked that README.md has the typo "recieve" on line 12.',
          ),
          reply("Got it."),
        ],
      },
    );

    const tasks = completedToolCalls("spawnAgent", conversation).map(
      (call) => (call.input as { task?: string } | undefined)?.task ?? "",
    );
    expect(tasks).toHaveLength(1);
    // The child gets no thread history, so the task must carry the fact
    // from the earlier message.
    expect(tasks[0]).toContain("README.md");
    expect(tasks[0]).toMatch(/recieve|receive/);
    expect(tasks[0]).toContain("12");
  });

  test("when a child agent is missing input, it reports the block in one result turn", async ({
    agent,
  }) => {
    const { run } = await agent();
    const requestedTools: string[] = [];
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Reply with the deploy region that the user chose. The region is not in this task." When its result arrives, tell me what happened.',
      ),
      { onProgress: recordToolRequests(requestedTools) },
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // Only the child agent has reportBlocked.
    expect(requestedTools).toContain("reportBlocked");
    expect(conversation.turns).toHaveLength(2);
    // The parent can end the result Turn with only a review item card, so
    // `no_reply` is a success. `asking.eval.ts` owns how the parent asks.
    expect(["no_reply", "succeeded"]).toContain(conversation.turns[1]?.status);
  });

  test("when a child agent is no longer needed, stop it without a result turn", async ({
    agent,
  }) => {
    const { run } = await agent();
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

  test("when a child agent uses its turn budget, its result starts a turn that succeeds", async ({
    agent,
  }) => {
    // Three tool calls stand in for a spent budget. Past the limit, Junior
    // blocks the next tool call and asks the child to reply with its progress.
    const { run } = await agent({
      limits: { maxToolCallsPerTurn: 3 },
    });
    const requestedTools: string[] = [];
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with the task "Call systemTime five times, one call per step. Then reply with how many of the calls returned a time." When its result arrives, tell me what the child agent reported.',
      ),
      { onProgress: recordToolRequests(requestedTools) },
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    expect(
      requestedTools.filter((name) => name === "systemTime").length,
    ).toBeGreaterThan(3);
    // Past the budget, the child can still reply.
    expect(requestedTools).toContain("reply");
    expect(conversation.turns).toHaveLength(2);
    expect(conversation.turns[1]?.status).toBe("succeeded");
  });

  test("when a child agent starts its own child agent, the helper's result reaches the thread once", async ({
    agent,
  }) => {
    const { run } = await agent({
      limits: { maxAgentDepth: 1 },
    });
    const conversation = await run(
      slackMention(
        'Use spawnAgent to start one child agent with this task: "Use spawnAgent to start one helper agent with the task \\"Reply with only the code word CEDAR-9.\\" When the helper\'s reply arrives, reply with only that code word." When the code word arrives, post it here.',
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toHaveLength(1);
    // The helper's reply starts the child's next Turn, which replies to the
    // parent. The code word is posted once.
    const replies = conversation.turns.flatMap((turn) => turn.replies);
    expect(
      replies.filter((reply) => reply.text.includes("CEDAR-9")),
    ).toHaveLength(1);
    expect(conversation.turns.at(-1)?.status).toBe("succeeded");
  });
});
