import { defineJuniorPlugins } from "@sentry/junior";
import { memoryPlugin } from "@sentry/junior-memory";
import { describe, expect } from "vitest";
import {
  evalDocsPlugin,
  failedDocReadHistory,
} from "@junior-evals/fixture/docs";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { readMemories } from "@junior-evals/fixture/memory";
import {
  completedMcpToolCalls,
  completedToolCalls,
  mcpToolCallsOf,
} from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

describe("User Memory", () => {
  test("when explicitly asked to remember a first-person preference, store one private memory", async ({
    run,
  }) => {
    const asked = await run(
      slackMention("Please remember that I prefer terse PR summaries.", {
        channelType: "im",
      }),
    );
    const recalled = await asked.continue(
      slackMention("What do you remember about how I like PR summaries?"),
    );
    await expect(recalled).toSatisfyJudge(
      RubricJudge,
      rubric({
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

    const conversation = await run(slackMention("what time is it"));
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
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
    );

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
      slackMention("ok remember that i think types in python are bad", {
        channelType: "im",
      }),
    );
    const conversation = await asked.continue(
      slackMention("What do you remember about my opinion on Python types?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
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

    const conversation = await run(
      slackMention(
        "Please remember that I want risk notes at the start of PR summaries.",
        { channelType: "im" },
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant confirms that the preference is already remembered or remains remembered.",
          "The assistant does not imply that a second or additional memory was created.",
        ],
        fail: [
          "Do not claim that a new or additional memory was created when the preference was already remembered.",
          "Do not expose hidden memory ids, scope keys, actor ids, or Slack ids.",
        ],
      }),
    );

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        content: existing,
        scope: "private",
        subjectType: "user",
      }),
    ]);
  });

  test("when a recalled memory conflicts with a fresh provider result, answer from the provider result", async ({
    agent,
  }) => {
    await insertMemory({
      content: "The release freeze ends Wednesday at 17:00 UTC.",
      kind: "knowledge",
    });
    const { run } = await agent({
      plugins: defineJuniorPlugins([memoryPlugin(), evalDocsPlugin]),
    });
    const conversation = await run(
      slackMention(
        "when does the current release freeze end? the policy is in our docs",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says that the release freeze ends Friday at 17:00 UTC.",
          "If the reply mentions Wednesday, it says that the docs page is the current source and Wednesday is out of date.",
        ],
        fail: [
          "Do not give Wednesday as the end of the freeze.",
          "Do not give both days as equally possible answers.",
        ],
      }),
    );

    expect(
      completedMcpToolCalls("mcp__eval-docs__fetch-doc", conversation).map(
        (call) => call.input,
      ),
    ).toContainEqual(
      expect.objectContaining({ arguments: { id: "pg_51e0aa" } }),
    );
  });

  test("when the requester pushes back on a failure without new evidence, check again or keep the evidence-backed answer", async ({
    agent,
  }) => {
    // A plausible memory that does not apply: the failed call was a read.
    await insertMemory({
      content:
        "Their docs connection does not have write access, so page edits fail.",
      kind: "knowledge",
    });
    const { run } = await agent({
      plugins: defineJuniorPlugins([memoryPlugin(), evalDocsPlugin]),
    });
    const conversation = await run(
      slackMention("you have docs access already, that's not it"),
      { history: failedDocReadHistory() },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply reports the result of a new read of the page, or it keeps the earlier finding that the read failed with a 404 and that the cause is not confirmed.",
          "If the reply gives a possible cause, it says that the cause is not confirmed.",
        ],
        fail: [
          "Do not agree with the requester and then give a new cause that no tool result in the thread shows.",
          "Do not give missing write access as the cause of the failed read.",
          "Do not say that the page was read or list checklist steps.",
        ],
      }),
    );

    expect(mcpToolCallsOf("mcp__eval-docs__update-doc", conversation)).toEqual(
      [],
    );
  });
});
