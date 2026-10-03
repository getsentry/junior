import { describe, expect } from "vitest";
import { mention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { rubric } from "@junior-evals/fixture/judge";
import { readMemories } from "@junior-evals/fixture/memory";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("User Memory", () => {
  test("when explicitly asked to remember a first-person preference, store one private memory", async ({
    run,
  }) => {
    const asked = await run(
      mention("Please remember that I prefer terse PR summaries.", {
        channelType: "im",
      }),
    );
    const recalled = await asked.continue(
      mention("What do you remember about how I like PR summaries?"),
      {
        criteria: rubric({
          pass: [
            "The assistant says it remembers a preference for terse PR summaries.",
            "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
          ],
          fail: [
            "Do not say the memory failed to save.",
            "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
            "Do not claim no relevant preference was remembered.",
          ],
        }),
      },
    );

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/terse/i),
        scope: "private",
        subjectType: "user",
      }),
    ]);
    expect(
      completedToolCalls("memory_createMemory", asked, recalled).length,
    ).toBeGreaterThan(0);
  });

  test("uses a remembered timezone when answering the current time", async ({
    run,
  }) => {
    // Use short SF/PT wording without an IANA token or "current time" phrase.
    const timezone = "Located in San Francisco and uses Pacific Time (PT).";
    await insertMemory({ content: timezone, visibility: "private" });
    // New public memory with the word "time" fills the public search window.
    for (let index = 0; index < 50; index += 1) {
      await insertMemory({
        content: `Recent workspace time note ${index} about deploy time windows`,
        kind: "knowledge",
        subjectType: "conversation",
      });
    }

    const conversation = await run(mention("what time is it"), {
      criteria: rubric({
        pass: [
          "The assistant uses the remembered San Francisco / Pacific Time preference from memory.",
          "The final answer reports the user's current local time in Pacific Time without asking for their location or timezone.",
        ],
        fail: [
          "Do not answer only with UTC or the server's timezone.",
          "Do not ask the user to restate their location or timezone.",
          "Do not claim that no relevant memory exists.",
        ],
      }),
    });

    expect(await readMemories()).toContainEqual(
      expect.objectContaining({
        content: timezone,
        scope: "private",
        subjectType: "user",
      }),
    );
    expect(completedToolCalls("systemTime", conversation)).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({ timezone: "America/Los_Angeles" }),
      }),
    );
    expect(conversation.toolCalls.map((call) => call.name)).not.toContain(
      "bash",
    );
  });

  test("when the actor states a first-person opinion, store it even if candidate wording is rewritten", async ({
    run,
  }) => {
    const asked = await run(
      mention("ok remember that i think types in python are bad", {
        channelType: "im",
      }),
    );
    await asked.continue(
      mention("What do you remember about my opinion on Python types?"),
      {
        criteria: rubric({
          pass: [
            "The assistant remembers that the user dislikes Python types or type annotations.",
            "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
          ],
          fail: [
            "Do not ask the user to rephrase the already first-person memory request.",
            "Do not claim no relevant preference was remembered.",
            "Do not store a memory about a third party.",
          ],
        }),
      },
    );

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        content: expect.stringMatching(/python/i),
        scope: "private",
        subjectType: "user",
      }),
    ]);
  });

  test("when explicitly asked to remember an existing preference, acknowledge the existing memory", async ({
    run,
  }) => {
    const existing = "Prefers PR summaries with risks first.";
    await insertMemory({ content: existing, visibility: "private" });

    await run(
      mention(
        "Please remember that I want risk notes at the start of PR summaries.",
        { channelType: "im" },
      ),
      {
        criteria: rubric({
          pass: [
            "The assistant confirms that the preference is already remembered or remains remembered.",
            "The assistant does not imply that a second or additional memory was created.",
          ],
          fail: [
            "Do not claim that a new or additional memory was created when the preference was already remembered.",
            "Do not expose hidden memory ids, scope keys, actor ids, or Slack ids.",
          ],
        }),
      },
    );

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        content: existing,
        scope: "private",
        subjectType: "user",
      }),
    ]);
  });
});
