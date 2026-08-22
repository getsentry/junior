import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";
import {
  clearMemories,
  countMemoryEmbeddings,
  expectActorMemorySemantics,
  expectAssistantMemoryAnswer,
  type MemoryThread,
  memoryPluginOverrides,
  readActiveMemories,
  readMemories,
  seedMemory,
  visibleAssistantText,
} from "./helpers";

describeEval("Personal Memory", slackEvals, (it) => {
  const explicitRememberThread = {
    id: "thread-memory-explicit-remember",
    channel_type: "channel",
    channel_id: "CMEMORYEXPLICIT",
    thread_ts: "17000000.000001",
  } satisfies MemoryThread;

  it("when explicitly asked to remember a public first-person preference, store one personal memory", async ({
    run,
  }) => {
    await clearMemories();
    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("Please remember that I prefer terse PR summaries.", {
          thread: explicitRememberThread,
        }),
      ],
      events: [
        mention("What do you remember about how I like PR summaries?", {
          thread: explicitRememberThread,
        }),
      ],
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
    });

    const rows = await readMemories(explicitRememberThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "user",
      }),
    ]);
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "searchTools",
          arguments: expect.objectContaining({ source: "memory" }),
        }),
        expect.objectContaining({
          name: "memory_createMemory",
        }),
      ]),
    );
    await expectActorMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning: "The actor prefers terse pull request summaries.",
      storedMemories: rows,
      userText: "Please remember that I prefer terse PR summaries.",
    });
  });

  const timezoneRecallThread = {
    id: "thread-memory-timezone-recall",
    // Public channel so conversation noise is workspace-scoped like production.
    channel_type: "channel",
    channel_id: "CMEMORYTIMEZONE",
    thread_ts: "17000000.000012",
  } satisfies MemoryThread;

  it("uses a remembered timezone when answering the current time", async ({
    run,
  }) => {
    await clearMemories();
    // Production-shaped personal pref: terse SF/PT wording without an IANA token
    // or "current time" phrasing. Host embedder still writes the vector row.
    const timezoneMemoryContent =
      "Located in San Francisco and uses Pacific Time (PT).";
    await seedMemory({
      content: timezoneMemoryContent,
      idempotencyKey: "eval-memory-timezone-recall",
      thread: timezoneRecallThread,
    });
    // Workspace conversation noise sharing the common token "time" fills the
    // shared lexical recency window the way production burial did.
    for (let index = 0; index < 50; index += 1) {
      await seedMemory({
        content: `Recent workspace time note ${index} about deploy time windows`,
        idempotencyKey: `eval-memory-timezone-noise-${index}`,
        kind: "knowledge",
        subject: "conversation",
        thread: timezoneRecallThread,
      });
    }
    await expect(countMemoryEmbeddings(timezoneRecallThread)).resolves.toBe(51);

    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("what time is it", {
          thread: timezoneRecallThread,
        }),
      ],
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

    await expect(readActiveMemories(timezoneRecallThread)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: timezoneMemoryContent,
          scope: "public",
        }),
      ]),
    );
    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "systemTime",
          status: "ok",
          arguments: expect.objectContaining({
            timezone: "America/Los_Angeles",
          }),
        }),
      ]),
    );
    expect(toolCalls(result.session).map((call) => call.name)).not.toContain(
      "bash",
    );
    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant uses the remembered San Francisco / Pacific Time preference and reports the user's current local time in Pacific Time.",
    });
  });

  const firstPersonRewrittenThread = {
    id: "thread-memory-first-person-rewritten",
    channel_type: "channel",
    channel_id: "CMEMORYFIRSTPERSON",
    thread_ts: "17000000.000002",
  } satisfies MemoryThread;

  it("when the actor states a first-person opinion, store it even if candidate wording is rewritten", async ({
    run,
  }) => {
    await clearMemories();
    const userText = "ok remember that i think types in python are bad";
    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(userText, {
          thread: firstPersonRewrittenThread,
        }),
      ],
      events: [
        mention("What do you remember about my opinion on Python types?", {
          thread: firstPersonRewrittenThread,
        }),
      ],
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
    });

    const rows = await readMemories(firstPersonRewrittenThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "user",
      }),
    ]);
    await expectActorMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "The actor thinks types in Python are bad or dislikes Python typing/type annotations.",
      storedMemories: rows,
      userText,
    });
  });

  const explicitDuplicateThread = {
    id: "thread-memory-explicit-duplicate",
    channel_type: "channel",
    channel_id: "CMEMORYEXPLICITDUPLICATE",
    thread_ts: "17000000.000004",
  } satisfies MemoryThread;

  it("when explicitly asked to remember an existing preference, acknowledge the existing memory", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-explicit-duplicate",
      thread: explicitDuplicateThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "Please remember that I want risk notes at the start of PR summaries.",
          { thread: explicitDuplicateThread },
        ),
      ],
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
    });

    await expect(readActiveMemories(explicitDuplicateThread)).resolves.toEqual([
      expect.objectContaining({
        content: "Prefers PR summaries with risks first.",
        scope: "public",
      }),
    ]);
  });
});
