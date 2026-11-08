import { describe, expect } from "vitest";
import { slackMention, webMessage } from "@junior-evals/fixture/inputs";
import {
  completedToolCalls,
  toolCallsOf,
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

function archivedIds(calls: ToolCall[]): string[] {
  return calls.map(
    (call) =>
      (call.input as { conversation_id?: string } | undefined)
        ?.conversation_id ?? "",
  );
}

// The user never names a kind. These cases measure whether Junior picks a
// Thread for work that people will talk to, and when it archives one.
describe("Threads", () => {
  test("when people will work through a long effort with Junior directly, start it as a Thread", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "We're starting the Postgres 17 upgrade. Give it its own space where Priya and I can work through the plan with you over the next couple of weeks, and kick it off with a first-pass checklist.",
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

    const cleanup = await conversation.continue(
      webMessage("Archive the threads that are done."),
    );

    expect(archivedIds(completedToolCalls("archiveAgent", cleanup))).toContain(
      childId(upgrade!),
    );
    expect(archivedIds(toolCallsOf("archiveAgent", cleanup))).not.toContain(
      childId(changelog!),
    );
  });
});
