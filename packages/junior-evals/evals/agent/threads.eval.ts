import { describe, expect } from "vitest";
import { slackMention, webMessage } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  toolOutput,
  type ToolCall,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

type SpawnInput = { kind?: string | null; task?: string };

function spawnInput(call: ToolCall): SpawnInput {
  return (call.input as SpawnInput | undefined) ?? {};
}

function childId(call: ToolCall): string {
  return (toolOutput(call) as { conversation_id: string }).conversation_id;
}

// The pick cases never name a kind. These cases measure whether Junior picks a
// Thread for work that people will talk to, and when it archives one.
describe("Threads", () => {
  test("when people will work through a long effort with Junior directly, start it as a Thread", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Put a dedicated agent on the Postgres 17 upgrade plan. Priya and I will check in with it directly over the next couple of weeks to steer it. Have it start with a first-pass checklist.",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.map((call) => spawnInput(call).kind)).toContain("thread");
  });

  // In Slack, "thread" can also mean a Slack thread, which Junior cannot start.
  // The work item is small so that the Thread finishes within the idle budget.
  test("when someone in Slack asks for a thread for one work item, start it as a Thread", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "can you create a thread to write a short runbook entry for rotating our webhook signing secret?",
      ),
    );

    const spawned = completedToolCalls("spawnAgent", conversation);
    expect(spawned.map((call) => spawnInput(call).kind)).toContain("thread");
  });

  test("when a Thread is finished, archive it, and leave the Thread a person still uses", async ({
    run,
  }) => {
    const conversation = await run(
      webMessage(
        "Start two threads that I can talk to directly. One drafts a three-line changelog entry for the new CSV export. The other lists five checks to run before a Postgres 17 upgrade. Keep both short.",
      ),
    );
    const threads = completedToolCalls("spawnAgent", conversation).filter(
      (call) => spawnInput(call).kind === "thread",
    );
    expect(threads).toHaveLength(2);
    const changelog = threads.find((call) =>
      /changelog|csv/i.test(spawnInput(call).task ?? ""),
    );
    const upgrade = threads.find((call) => call !== changelog);
    expect(changelog).toBeDefined();
    expect(upgrade).toBeDefined();

    // The person keeps working in the changelog Thread.
    const changelogThread = await conversation.child(childId(changelog!));
    await changelogThread.continue(
      webMessage(
        "Good start. Add a line about the new date filter. I'll send more notes after lunch.",
      ),
    );

    await conversation.continue(
      webMessage("Archive the threads that are done."),
    );

    // Read the result as the dashboard shows it, however the agent made the
    // calls.
    expect((await conversation.child(childId(upgrade!))).archived).toBe(true);
    expect((await conversation.child(childId(changelog!))).archived).toBe(
      false,
    );
  });
});
