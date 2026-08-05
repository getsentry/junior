import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";
import {
  clearMemories,
  countMemoryEmbeddings,
  evalMemoryModel,
  expectActorMemorySemantics,
  expectAssistantMemoryAnswer,
  memoryPluginOverrides,
  readActiveMemories,
  readMemories,
  seedMemory,
  visibleAssistantText,
} from "./helpers";
import { createMemoryAgent } from "../../../junior-memory/src/agent";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { TEST_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";

const memoryTeamId = "TEVAL";
const actorUserId = TEST_USER_ID;

describeEval("Personal Memory", slackEvals, (it) => {
  const explicitRememberThread = {
    id: "thread-memory-explicit-remember",
    channel_id: "CMEMORYEXPLICIT",
    thread_ts: "17000000.000001",
  };

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
        mention("List the exact stored memory content for that preference.", {
          thread: explicitRememberThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "Treat createMemory arguments as candidate input, not stored content.",
          "The assistant uses the exact canonical stored memory content. Good: 'Prefers terse PR summaries'. Bad: 'The actor prefers terse PR summaries'. Bad: 'I prefer terse PR summaries'.",
          "The assistant does not ask the user to provide hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not fail only because the createMemory candidate uses natural first-person or display-name phrasing; the stored/listed memory content is the contract.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
          "Do not present actor names, display names, 'the actor', 'the user', 'I', 'my', thread labels, channel labels, or source labels as the stored memory content.",
          "Do not say the memory failed to save.",
        ],
      }),
    });

    const rows = await readMemories(explicitRememberThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
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
    channel_id: "CMEMORYTIMEZONE",
    thread_ts: "17000000.000012",
  };

  it("uses a remembered timezone when answering the current time", async ({
    run,
  }) => {
    await clearMemories();
    // Seed a hybrid-retrievable fact: host embedder writes the vector row, and
    // content keeps FTS overlap with "current time" asks plus the exact IANA token.
    const timezoneMemoryContent =
      "Prefers current local time answers in America/Los_Angeles (San Francisco timezone).";
    await seedMemory({
      content: timezoneMemoryContent,
      idempotencyKey: "eval-memory-timezone-recall",
      thread: timezoneRecallThread,
    });
    await expect(countMemoryEmbeddings(timezoneRecallThread)).resolves.toBe(1);

    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("What time is it for me right now?", {
          thread: timezoneRecallThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant uses the remembered San Francisco / America/Los_Angeles timezone from memory.",
          "The final answer reports the user's current local time in Pacific Time without asking for their location or timezone.",
          "The assistant checks the current time with systemTime before answering.",
        ],
        fail: [
          "Do not answer only with UTC or the server's timezone.",
          "Do not ask the user to restate their location or timezone.",
          "Do not claim that no relevant memory exists.",
          "Do not shell out to bash or other tools just to convert the current time into the remembered timezone.",
        ],
      }),
    });

    await expect(readActiveMemories(timezoneRecallThread)).resolves.toEqual([
      expect.objectContaining({
        content: timezoneMemoryContent,
        scope: "personal",
      }),
    ]);
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
        "The assistant uses the remembered San Francisco or America/Los_Angeles timezone and reports the user's current local time in Pacific Time.",
    });
  }, 120_000);

  const firstPersonRewrittenThread = {
    id: "thread-memory-first-person-rewritten",
    channel_id: "CMEMORYFIRSTPERSON",
    thread_ts: "17000000.000002",
  };

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
        mention("What exact memory did you store about Python types?", {
          thread: firstPersonRewrittenThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant treats the user's first-person request as actor-authored source evidence.",
          "The assistant stores and later reports a canonical actor memory matching the user's opinion about Python types.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not refuse the memory because a candidate or reply uses the actor's name, 'the actor', or third-person wording.",
          "Do not ask the user to rephrase the already first-person memory request.",
          "Do not store a memory about a third party.",
        ],
      }),
    });

    const rows = await readMemories(firstPersonRewrittenThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
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
    channel_id: "CMEMORYEXPLICITDUPLICATE",
    thread_ts: "17000000.000004",
  };

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
        scope: "personal",
      }),
    ]);
  });

  it("when adjudicating preferences, distinguish duplicates, replacements, and additive preferences", async () => {
    const agent = createMemoryAgent(evalMemoryModel);
    const runtimeContext = {
      conversationId: "slack:CMEMORYSUPERSESSION:17000000.000003",
      actor: {
        platform: "slack" as const,
        teamId: memoryTeamId,
        userId: actorUserId,
      },
      source: createSlackSource({
        channelId: "CMEMORYSUPERSESSION",
        messageTs: "17000000.000003",
        teamId: memoryTeamId,
        threadTs: "17000000.000003",

        visibility: "private",
      }),
    };

    const replacement = await agent.adjudicateSupersession({
      candidate: {
        content: "Prefers TypeScript for automation scripts.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers Python for automation scripts.",
          id: "memory-old-language",
        },
      ],
      runtimeContext,
    });
    expect(replacement).toEqual({
      decision: "supersedes_old",
      supersededIds: ["memory-old-language"],
    });

    const duplicate = await agent.adjudicateSupersession({
      candidate: {
        content: "Wants meeting reminders 24 hours in advance.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers calendar reminders one day before meetings.",
          id: "memory-existing-reminder-timing",
        },
      ],
      runtimeContext,
    });
    expect(duplicate).toEqual({
      decision: "duplicate",
      duplicateId: "memory-existing-reminder-timing",
    });

    const additive = await agent.adjudicateSupersession({
      candidate: {
        content: "Prefers Slack updates in the morning.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers terse PR summaries.",
          id: "memory-old-summary-style",
        },
      ],
      runtimeContext,
    });
    expect(additive).toEqual({ decision: "distinct" });

    const sameTopicAdditive = await agent.adjudicateSupersession({
      candidate: {
        content: "Prefers PR summaries to name an owner for every risk.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers PR summaries with risks first.",
          id: "memory-existing-summary-order",
        },
      ],
      runtimeContext,
    });
    expect(sameTopicAdditive).toEqual({ decision: "distinct" });
  }, 120_000);
});
