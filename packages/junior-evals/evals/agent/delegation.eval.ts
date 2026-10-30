import { describe, expect } from "vitest";
import { slackMention, slackThreadMessage } from "@junior-evals/fixture/inputs";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // The parent makes its choice in its first Turn. The research of the
    // child agents is not part of this case. So each child waits until the
    // person reads the parent's reply and says "stop", and the stop ends the
    // child agents before they call the model. The wait has a bound, so the
    // call does not hang when the parent never replies.
    // A small budget bounds the run when the parent does the research itself.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    let spawnRequested = false;
    let stopping: Promise<void> | undefined;
    let releaseChildren!: () => void;
    const childrenReleased = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    const conversation = await run(
      slackMention(
        "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
      ),
      {
        onProgress: async (progress, { send }) => {
          if (progress.type === "tool_request") {
            if (progress.name === "spawnAgent") spawnRequested = true;
          } else if (progress.type === "child_agent") {
            bound ??= setTimeout(releaseChildren, 30_000);
            await childrenReleased;
          } else if (progress.type === "reply" && spawnRequested && !stopping) {
            // Slack posts the reply only after this handler returns, so do
            // not wait for the stop here. The stop is recorded when `send`
            // returns.
            stopping = send(slackThreadMessage("stop")).finally(
              releaseChildren,
            );
          }
        },
      },
    );
    clearTimeout(bound);
    await stopping;

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
