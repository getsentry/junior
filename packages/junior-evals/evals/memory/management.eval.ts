import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";
import {
  clearMemories,
  memoryPluginOverrides,
  type MemoryThread,
  readActiveMemories,
  readMemories,
  seedMemory,
} from "./helpers";

describeEval("Memory Management", slackEvals, (it) => {
  const autoRecallThread = {
    id: "thread-memory-auto-recall",
    channel_type: "im",
    channel_id: "DMEMORYAUTORECALL",
    thread_ts: "17000000.000009",
  } satisfies MemoryThread;

  it("automatically injects relevant memories without requiring a recall tool", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-auto-recall",
      thread: autoRecallThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("How should I structure my next PR summary?", {
          thread: autoRecallThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant uses memory to say the user prefers PR summaries with risks first.",
          "The assistant does not ask the user to restate the preference.",
        ],
        fail: [
          "Do not answer as if no relevant preference exists.",
          "Do not mention hidden storage fields, scope keys, or Slack ids.",
        ],
      }),
    });

    const rows = await readMemories(autoRecallThread);
    expect(rows).toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers PR summaries with risks first.",
        scope: "private",
        scopeKey: expect.any(String),
        subjectType: "user",
      }),
    );
  });

  const passiveDedupeThread = {
    id: "thread-memory-passive-dedupe",
    channel_type: "im",
    channel_id: "DMEMORYPASSIVEDEDUPE",
    thread_ts: "17000000.000010",
  } satisfies MemoryThread;

  it("does not passively duplicate an existing semantic memory", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-passive-dedupe",
      thread: passiveDedupeThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("For PR summaries, I still want risk notes first.", {
          thread: passiveDedupeThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant acknowledges that PR summaries should continue to put risks first.",
          "The assistant does not mention hidden storage fields, scope keys, or Slack ids.",
        ],
        fail: [
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    });

    const rows = await readActiveMemories(passiveDedupeThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers PR summaries with risks first.",
        scope: "private",
        scopeKey: expect.any(String),
        subjectType: "user",
      }),
    ]);
  });

  const removeThread = {
    id: "thread-memory-remove",
    channel_id: "CMEMORYREMOVE",
    thread_ts: "17000000.000011",
  };

  it("when asked to forget a remembered preference, archive the matching memory", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers terse PR summaries.",
      idempotencyKey: "eval-memory-remove",
      thread: removeThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("Please forget that I prefer terse PR summaries.", {
          thread: removeThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant understands the forget request and removes the matching remembered preference.",
          "The assistant does not ask the user for hidden ids or scope fields.",
        ],
        fail: [
          "Do not claim the memory was removed if the assistant cannot identify the matching remembered preference.",
          "Do not ask the user for Slack ids, scope keys, or subject ids.",
        ],
      }),
    });

    const memories = await readMemories(removeThread);
    expect(memories).toEqual([
      expect.objectContaining({
        archivedAtMs: expect.any(Number),
        content: "Prefers terse PR summaries.",
      }),
    ]);
    expect(
      memories.filter(
        (memory) =>
          memory.content === "Prefers terse PR summaries." &&
          memory.archivedAtMs === null,
      ),
    ).toEqual([]);
  });
});
