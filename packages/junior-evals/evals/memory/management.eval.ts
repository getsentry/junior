import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { readMemories } from "@junior-evals/fixture/memory";
import { test } from "@junior-evals/fixture/test";

const RISKS_FIRST = "Prefers PR summaries with risks first.";

describe("Memory Management", () => {
  test("automatically injects relevant memories without requiring a recall tool", async ({
    run,
  }) => {
    await insertMemory({ content: RISKS_FIRST, visibility: "private" });

    const conversation = await run(
      slackMention("How should I structure my next PR summary?", {
        channelType: "im",
      }),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant uses memory to say the user prefers PR summaries with risks first.",
          "The assistant does not ask the user to restate the preference.",
        ],
        fail: [
          "Do not answer as if no relevant preference exists.",
          "Do not mention hidden storage fields, scope keys, or Slack ids.",
        ],
      }),
    );

    expect(await readMemories()).toContainEqual(
      expect.objectContaining({
        content: RISKS_FIRST,
        scope: "private",
        subjectType: "user",
      }),
    );
  });

  test("does not passively duplicate an existing semantic memory", async ({
    run,
  }) => {
    await insertMemory({ content: RISKS_FIRST, visibility: "private" });

    const conversation = await run(
      slackMention("For PR summaries, I still want risk notes first.", {
        channelType: "im",
      }),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant acknowledges that PR summaries should continue to put risks first.",
          "The assistant does not mention hidden storage fields, scope keys, or Slack ids.",
        ],
        fail: [
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    );

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        content: RISKS_FIRST,
        scope: "private",
        subjectType: "user",
      }),
    ]);
  });

  test("when asked to forget a remembered preference, archive the matching memory", async ({
    run,
  }) => {
    await insertMemory({
      content: "Prefers terse PR summaries.",
      visibility: "private",
    });

    const conversation = await run(
      slackMention("Please forget that I prefer terse PR summaries."),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant understands the forget request and removes the matching remembered preference.",
          "The assistant does not ask the user for hidden ids or scope fields.",
        ],
        fail: [
          "Do not claim the memory was removed if the assistant cannot identify the matching remembered preference.",
          "Do not ask the user for Slack ids, scope keys, or subject ids.",
        ],
      }),
    );

    // A forgotten memory is archived, so the person can no longer recall it.
    expect(await readMemories()).toEqual([]);
  });
});
