import { describe, expect } from "vitest";
import { mockDatabaseDocs } from "@junior-evals/fixture/database-docs";
import { slackMention } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { completedToolCalls, type Turn } from "@junior-evals/fixture/results";
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
});

/** Turns that posted something people saw. */
function postedTurns(turns: Turn[]) {
  return turns.filter((turn) => turn.replies.length > 0);
}

// The user never names spawnAgent or asks for updates. These cases measure
// whether Junior decides on its own which child agent updates people need.
describe("Child Agent Updates", () => {
  test("when delegated research is the only outcome of the first turn, post a short status and then only the answer", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures which updates
    // the parent posts, not the quality of the research.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "can you dig into how postgres, mysql, and sqlite each deal with adding a NOT NULL column with a default to a really big table? locking, rewrite cost, replication. use their own docs, then tell me the tradeoffs",
      ),
    );

    const [first, ...later] = conversation.turns;
    expect(
      first?.toolCalls.filter((call) => call.name === "spawnAgent").length,
    ).toBeGreaterThanOrEqual(2);
    // Without a status, the thread looks finished while children still work.
    expect(first?.replies).toHaveLength(1);
    // A result that arrives while another child still works is not worth a
    // post of its own. Only the combined answer posts.
    expect(postedTurns(later)).toHaveLength(1);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The first reply briefly tells the user that the research is under way.",
          "The last reply compares how PostgreSQL, MySQL, and SQLite handle the change.",
        ],
        fail: ["The first reply states findings about a database."],
      }),
    );
  });

  test("when the user asks to hear back only with the answer, post nothing until then", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "no rush and no need to check in: look up how postgres, mysql, and sqlite each handle adding a NOT NULL column with a default to a huge table, from their own docs. just post the comparison when it's done",
      ),
    );

    expect(postedTurns(conversation.turns)).toHaveLength(1);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The only reply compares how PostgreSQL, MySQL, and SQLite handle the change.",
        ],
      }),
    );
  });
});
