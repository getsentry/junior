import { describe, expect } from "vitest";
import { slackMention, slackThreadMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // The parent decides to delegate in its first Turn. The research of the
    // child agents and the parent's summary are not part of this case, and
    // live they take more than 60 seconds. So the person says "stop" after
    // the parent's first reply, and the stop ends the child agents too.
    // A child agent waits at its first tool request until the stop is sent,
    // so a replay and the recording run make the same requests. The wait has
    // a bound, so a parent that calls a tool before it replies goes on.
    // A small budget bounds the run when the parent does the research itself.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    let spawnRequests = 0;
    let stopSent!: () => void;
    const stopSentOnce = new Promise<void>((resolve) => {
      stopSent = resolve;
    });
    let stopping = false;
    const conversation = await run(
      slackMention(
        "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
      ),
      {
        onProgress: async (progress, { send }) => {
          if (progress.type === "tool_request") {
            if (progress.name === "spawnAgent") {
              spawnRequests += 1;
            } else if (spawnRequests > 0) {
              await Promise.race([stopSentOnce, delay(15_000)]);
              // The worker checks for a stop every 500 ms.
              await delay(1_500);
            }
          } else if (
            progress.type === "reply" &&
            spawnRequests > 0 &&
            !stopping
          ) {
            stopping = true;
            await send(slackThreadMessage("stop"));
            stopSent();
          }
        },
      },
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
  });

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
