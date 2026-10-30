import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
// The call waits for the child agents' research and the parent's summary.
// In live runs, one child Turn or the summary alone can take more than 60
// seconds. Recorded runs finish in about 10 seconds. The test timeout leaves
// room for cleanup after the idle budget.
const CHILD_RESEARCH_IDLE_MS = 120_000;
const CHILD_RESEARCH_TEST_TIMEOUT_MS = 240_000;

describe("Implicit Delegation", () => {
  test(
    "when a request splits into independent research tracks, start a child agent for each track",
    async ({ agent }) => {
      // A small budget keeps each child short. The case measures the parent's
      // choice to delegate, not the quality of the children's research.
      const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
      const conversation = await run(
        slackMention(
          "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
        ),
        { idleTimeoutMs: CHILD_RESEARCH_IDLE_MS },
      );

      const spawned = completedToolCalls("spawnAgent", conversation);
      expect(spawned.length).toBeGreaterThanOrEqual(2);
    },
    CHILD_RESEARCH_TEST_TIMEOUT_MS,
  );

  test("when a request needs only a few direct tool calls, do the work without a child agent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC and in Tokyo?"),
    );

    expect(completedToolCalls("spawnAgent", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });
});
