import { describe, expect } from "vitest";
import { mockDatabaseDocs } from "@junior-evals/fixture/database-docs";
import { slackMention, webMessage } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";
import { mockWebPages } from "@junior-evals/fixture/web";

type SpawnInput = { fork?: boolean | null; kind?: string | null };

function spawnInput(call: ToolCall): SpawnInput {
  return (call.input as SpawnInput | undefined) ?? {};
}

type TodosInput = {
  add?: Array<{ assignee?: string | null }> | null;
  update?: Array<{ assignee?: string | null }> | null;
};

/** Assignees that `todos_updateTodos` calls set on new or changed To-dos. */
function todoAssignees(calls: ToolCall[]): string[] {
  return calls.flatMap((call) => {
    const input = (call.input as TodosInput | undefined) ?? {};
    return [...(input.add ?? []), ...(input.update ?? [])].flatMap((todo) =>
      todo.assignee ? [todo.assignee] : [],
    );
  });
}

// The user never names startAgent here. These cases measure whether Junior
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

    const spawned = completedToolCalls("startAgent", conversation);
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    // Research that only the parent reads is background work: a Task.
    expect(spawned.map((call) => spawnInput(call).kind)).not.toContain(
      "thread",
    );
    // A brief can carry each track, so no child needs this conversation.
    expect(spawned.map((call) => spawnInput(call).fork)).not.toContain(true);
  });

  test("when a request queues more work for a child agent, keep that work on a To-do with the child as assignee", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 6 } });
    mockDatabaseDocs();
    const conversation = await run(
      slackMention(
        "have a background agent look up how PostgreSQL handles adding a NOT NULL column with a default to a huge table, from the postgres docs. when it's done, have that same agent turn what it found into a short migration checklist for us. then send me the checklist",
      ),
    );

    expect(completedToolCalls("startAgent", conversation)).not.toEqual([]);
    // The checklist waits on the first task. Only a To-do keeps it if
    // history is compacted before the result arrives.
    expect(
      todoAssignees(completedToolCalls("todos_updateTodos", conversation)),
    ).toEqual(expect.arrayContaining([expect.not.stringMatching(/^self$/i)]));
  });

  test("when a multi-step request finishes in this Turn, add no To-dos", async ({
    run,
  }) => {
    const index = "https://example.com/runbooks";
    mockWebPages({
      [index]: `<html><body><h1>Runbooks</h1><ul><li><a href="${index}/rotate-keys">Rotate API keys</a></li><li><a href="${index}/restore-backup">Restore a backup</a></li></ul></body></html>`,
      [`${index}/rotate-keys`]: `<html><body><h1>Rotate API keys</h1><p>See <a href="${index}/rotate-keys/verify">verification</a>.</p></body></html>`,
      [`${index}/rotate-keys/verify`]: `<html><body><h1>Verify a key rotation</h1><p>Run the smoke test, then confirm that the old key returns 401.</p></body></html>`,
      [`${index}/restore-backup`]: `<html><body><h1>Restore a backup</h1></body></html>`,
    });
    const conversation = await run(
      slackMention(
        `${index} lists our runbooks. Open the key rotation one, follow its link to the verification page, and tell me how to verify a rotation.`,
      ),
    );

    // To-dos hold only work that outlives the Turn.
    expect(completedToolCalls("todos_updateTodos", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });

  test("when a request needs only a few direct tool calls, do the work without a child agent", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("what time is it right now in UTC and in Tokyo?"),
    );

    expect(completedToolCalls("startAgent", conversation)).toEqual([]);
    expect(conversation.replies).toHaveLength(1);
  });

  // A Lead's `startConversation` makes a web root whose first message is the
  // brief, sent as the person, so this web message is that root's first
  // Turn. The case measures only whether the root hands its one work item to
  // a child agent, which it does in its first calls, so a budget of 3 keeps
  // the build short.
  test("when a Conversation is asked for one long code change, do it here and do not hand it to a child agent", async ({
    agent,
  }) => {
    const { run } = await agent({ limits: { maxToolCallsPerTurn: 3 } });
    const conversation = await run(
      webMessage(
        [
          "In acme/storefront, build one reusable coupon-code input for the cart and checkout pages. Today each page has its own copy, and neither shows why a code was rejected.",
          "",
          "Do this:",
          "1. Find every place the UI takes a coupon code today.",
          "2. Build one component on the existing design system: validation on submit, an error message from the API, and a clear button. It must work on a phone.",
          "3. Replace both copies with it.",
          "4. Add unit tests for the component.",
          "5. Open a pull request and bring it to me only once it is ready for review: checks passing, not a draft.",
        ].join("\n"),
      ),
    );

    expect(completedToolCalls("startAgent", conversation)).toEqual([]);
  });
});
