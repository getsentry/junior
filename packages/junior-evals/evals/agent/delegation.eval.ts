import { describe, expect } from "vitest";
import { mockDatabaseDocs } from "@junior-evals/fixture/database-docs";
import { slackMention } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

type SpawnInput = { fork?: boolean | null; kind?: string | null };

function spawnInput(call: ToolCall): SpawnInput {
  return (call.input as SpawnInput | undefined) ?? {};
}

type PlanInput = {
  add?: Array<{ assignee?: string | null }> | null;
  update?: Array<{ assignee?: string | null }> | null;
};

/** Assignees that `updatePlan` calls set on new or changed items. */
function planAssignees(calls: ToolCall[]): string[] {
  return calls.flatMap((call) => {
    const input = (call.input as PlanInput | undefined) ?? {};
    return [...(input.add ?? []), ...(input.update ?? [])].flatMap((item) =>
      item.assignee ? [item.assignee] : [],
    );
  });
}

// The user never names spawnAgent here. These cases measure whether Junior
// decides on its own when delegation pays for itself.
describe("Implicit Delegation", () => {
  test("when a request splits into independent research tracks, start a child agent for each track", async ({
    agent,
  }) => {
    // A small budget keeps each child short. The case measures the parent's
    // choice to delegate, not the quality of the children's research.
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "I need to pick a database for a new service. Research how PostgreSQL, MySQL, and SQLite each handle adding a NOT NULL column with a default to a very large table: locking, rewrite cost, and replication impact. Go to each project's own docs, then give me the tradeoffs.",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    // Research that only the parent reads is background work: a Task.
    expect(spawned.map((call) => spawnInput(call).kind)).not.toContain(
      "thread",
    );
    // A brief can carry each track, so no child needs this conversation.
    expect(spawned.map((call) => spawnInput(call).fork)).not.toContain(true);
  });

  test("when a request queues more work for a child agent, keep that work on the plan with the child as assignee", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "have a background agent look up how PostgreSQL handles adding a NOT NULL column with a default to a huge table, from the postgres docs. when it's done, have that same agent turn what it found into a short migration checklist for us. then send me the checklist",
      ),
    );

    expect(completedToolCalls("spawnAgent", conversation)).not.toEqual([]);
    // The checklist waits on the first task. Only the plan keeps it if
    // history is compacted before the result arrives.
    expect(
      planAssignees(completedToolCalls("updatePlan", conversation)),
    ).toEqual(expect.arrayContaining([expect.not.stringMatching(/^self$/i)]));
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
