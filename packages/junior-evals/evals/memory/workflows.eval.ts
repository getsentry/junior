import { afterEach, expect } from "vitest";
import { assistantMessages, describeEval } from "vitest-evals";
import { closeDb, getDb } from "@/chat/db";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { juniorMemoryMemories } from "../../../junior-memory/src/db/schema";
import { mention, rubric, slackEvals } from "../../src/helpers";

const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";
const requesterUserId = "U-test";
const memoryJudgeModelId = resolveGatewayModel("openai/gpt-5.4").id;

interface MemoryThread {
  channel_id: string;
  id: string;
  thread_ts: string;
}

function memoryContext(thread: MemoryThread) {
  return {
    conversationId: `slack:${thread.channel_id}:${thread.thread_ts}`,
    requester: {
      platform: "slack" as const,
      teamId: memoryTeamId,
      userId: requesterUserId,
    },
    source: {
      platform: "slack" as const,
      teamId: memoryTeamId,
      channelId: thread.channel_id,
      messageTs: thread.thread_ts,
      threadTs: thread.thread_ts,
    },
  };
}

async function seedMemory(args: {
  content: string;
  idempotencyKey: string;
  scope?: "conversation" | "personal";
  thread: MemoryThread;
}) {
  const store = createMemoryStore(memoryDb(), memoryContext(args.thread));
  const input = {
    content: args.content,
    idempotencyKey: args.idempotencyKey,
  };
  if (args.scope === "conversation") {
    return await store.createConversationMemory(input);
  }
  return await store.createMemory(input);
}

function memoryDb(): MemoryDb {
  return getDb() as unknown as MemoryDb;
}

async function readMemories() {
  return await memoryDb()
    .select()
    .from(juniorMemoryMemories)
    .orderBy(juniorMemoryMemories.createdAtMs, juniorMemoryMemories.id);
}

function visibleAssistantText(result: {
  session: Parameters<typeof assistantMessages>[0];
}): string {
  return assistantMessages(result.session)
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .join("\n");
}

interface MemorySemanticJudgmentInput {
  assistantText: string;
  expectedMeaning: string;
  storedMemories: Awaited<ReturnType<typeof readMemories>>;
  userText: string;
}

function parseMemoryJudgeResult(text: string): {
  passed: boolean;
  rationale: string;
} {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Memory judge returned non-object JSON: ${text}`);
  }
  const passed = (parsed as Record<string, unknown>).passed;
  const rationale = (parsed as Record<string, unknown>).rationale;
  if (typeof passed !== "boolean" || typeof rationale !== "string") {
    throw new Error(`Memory judge returned invalid JSON: ${text}`);
  }
  return { passed, rationale };
}

async function expectRequesterMemorySemantics(
  input: MemorySemanticJudgmentInput,
): Promise<void> {
  const { text } = await completeText({
    modelId: memoryJudgeModelId,
    system:
      'You judge Junior memory eval results. Return only raw JSON matching {"passed":boolean,"rationale":"..."}.',
    messages: [
      {
        role: "user",
        content: [
          "<memory-eval>",
          "<user-text>",
          input.userText,
          "</user-text>",
          "<expected-meaning>",
          input.expectedMeaning,
          "</expected-meaning>",
          "<stored-memories-json>",
          JSON.stringify(
            input.storedMemories.map((memory) => ({
              archivedAtMs: memory.archivedAtMs,
              content: memory.content,
              scope: memory.scope,
              subjectType: memory.subjectType,
            })),
          ),
          "</stored-memories-json>",
          "<assistant-text>",
          input.assistantText,
          "</assistant-text>",
          "<criteria>",
          "Pass only if exactly one active personal/user memory is stored and its content is semantically equivalent to the expected meaning.",
          "The stored content must be canonical memory text: no requester display name, no 'the requester', no 'the user', no first-person wording, and no thread/channel/source wording.",
          "The assistant text must not claim the memory failed because the user's first-person request was rewritten in third person.",
          "Fail if no memory was stored, if the stored memory is about someone other than the requester, if the content is a vague paraphrase, or if the content preserves source/user labels.",
          "</criteria>",
          "</memory-eval>",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    temperature: 0,
  });
  const judgment = parseMemoryJudgeResult(text);
  expect(judgment, judgment.rationale).toEqual(
    expect.objectContaining({ passed: true }),
  );
}

async function expectAssistantMemoryAnswer(args: {
  assistantText: string;
  expectedBehavior: string;
}): Promise<void> {
  const { text } = await completeText({
    modelId: memoryJudgeModelId,
    system:
      'You judge Junior memory eval replies. Return only raw JSON matching {"passed":boolean,"rationale":"..."}.',
    messages: [
      {
        role: "user",
        content: [
          "<assistant-text>",
          args.assistantText,
          "</assistant-text>",
          "<expected-behavior>",
          args.expectedBehavior,
          "</expected-behavior>",
          "<criteria>",
          "Pass only if the assistant text satisfies the expected behavior.",
          "Fail if the assistant asks the user to restate the remembered fact, claims no relevant memory exists, or exposes hidden storage fields such as scope keys or Slack ids.",
          "</criteria>",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    temperature: 0,
  });
  const judgment = parseMemoryJudgeResult(text);
  expect(judgment, judgment.rationale).toEqual(
    expect.objectContaining({ passed: true }),
  );
}

function expectMemoryIdReference(text: string, memoryId: string): void {
  expect(
    Array.from({ length: memoryId.length - 11 }, (_, index) =>
      memoryId.slice(0, index + 12),
    ).some((prefix) => text.includes(prefix)),
  ).toBe(true);
}

afterEach(async () => {
  await closeDb();
});

describeEval("Memory Workflows", slackEvals, (it) => {
  const explicitRememberThread = {
    id: "thread-memory-explicit-remember",
    channel_id: "CMEMORYEXPLICIT",
    thread_ts: "17000000.memory-explicit",
  };

  it("when explicitly asked to remember a public first-person preference, store one personal memory", async ({
    run,
  }) => {
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Please remember that I prefer terse PR summaries.", {
          thread: explicitRememberThread,
        }),
        mention("List the exact stored memory content for that preference.", {
          thread: explicitRememberThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "Treat createMemory arguments as candidate input, not stored content.",
          "The assistant uses the exact canonical stored memory content. Good: 'Prefers terse PR summaries'. Bad: 'The requester prefers terse PR summaries'. Bad: 'I prefer terse PR summaries'.",
          "The assistant does not ask the user to provide hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not fail only because the createMemory candidate uses natural first-person or display-name phrasing; the stored/listed memory content is the contract.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
          "Do not present requester names, display names, 'the requester', 'the user', 'I', 'my', thread labels, channel labels, or source labels as the stored memory content.",
          "Do not say the memory failed to save.",
        ],
      }),
    });

    const rows = await readMemories();
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
        subjectType: "user",
      }),
    ]);
    await expectRequesterMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning: "The requester prefers terse pull request summaries.",
      storedMemories: rows,
      userText: "Please remember that I prefer terse PR summaries.",
    });
  });

  const firstPersonRewrittenThread = {
    id: "thread-memory-first-person-rewritten",
    channel_id: "CMEMORYFIRSTPERSON",
    thread_ts: "17000000.memory-first-person",
  };

  it("when the requester states a first-person opinion, store it even if candidate wording is rewritten", async ({
    run,
  }) => {
    const userText = "ok remember that i think types in python are bad";
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(userText, {
          thread: firstPersonRewrittenThread,
        }),
        mention("What exact memory did you store about Python types?", {
          thread: firstPersonRewrittenThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant treats the user's first-person request as requester-authored source evidence.",
          "The assistant stores and later reports a canonical requester memory matching the user's opinion about Python types.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not refuse the memory because a candidate or reply uses the requester's name, 'the requester', or third-person wording.",
          "Do not ask the user to rephrase the already first-person memory request.",
          "Do not store a memory about a third party.",
        ],
      }),
    });

    const rows = await readMemories();
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
        subjectType: "user",
      }),
    ]);
    await expectRequesterMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "The requester thinks types in Python are bad or dislikes Python typing/type annotations.",
      storedMemories: rows,
      userText,
    });
  });

  const thirdPartyRememberThread = {
    id: "thread-memory-third-party-remember",
    channel_id: "CMEMORYTHIRDPARTY",
    thread_ts: "17000000.memory-third-party",
  };

  it("when asked to remember another person's personal preference, store nothing", async ({
    run,
  }) => {
    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Please remember that David prefers terse PR summaries.", {
          thread: thirdPartyRememberThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant does not store David's personal preference as a requester memory.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not claim David's preference was saved as a memory.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    });

    expect(await readMemories()).toEqual([]);
  });

  const listThread = {
    id: "thread-memory-list",
    channel_id: "CMEMORYLIST",
    thread_ts: "17000000.memory-list",
  };

  it("listMemories reads visible memories before answering what Junior remembers", async ({
    run,
  }) => {
    const seeded = await seedMemory({
      content: "Prefers terse PR summaries.",
      idempotencyKey: "eval-memory-list",
      thread: listThread,
    });

    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(
          "List the exact memories you have about how I like PR summaries, including the memory id.",
          {
            thread: listThread,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant lists the stored memory about terse PR summaries.",
          "The assistant includes a memory id or id prefix from the memory tool output.",
          "The assistant does not ask the user to restate the preference.",
        ],
        fail: [
          "Do not answer as if no relevant memory exists.",
          "Do not mention hidden storage fields, scope keys, or Slack ids.",
        ],
      }),
    });

    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant lists the stored memory that the requester prefers terse PR summaries.",
    });
    expectMemoryIdReference(visibleAssistantText(result), seeded.memory.id);
    expect(await readMemories()).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers terse PR summaries.",
        scope: "personal",
      }),
    ]);
  });

  const searchThread = {
    id: "thread-memory-search",
    channel_id: "CMEMORYSEARCH",
    thread_ts: "17000000.memory-search",
  };

  it("searchMemories finds the relevant stored memory for a targeted recall request", async ({
    run,
  }) => {
    const match = await seedMemory({
      content: "Prefers incident reports with bullet summaries.",
      idempotencyKey: "eval-memory-search-match",
      thread: searchThread,
    });
    await seedMemory({
      content: "Prefers terse PR summaries.",
      idempotencyKey: "eval-memory-search-distractor",
      thread: searchThread,
    });

    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(
          "Search memory for my incident report preference and include the matching memory id with the answer.",
          {
            thread: searchThread,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant answers from memory that the user likes incident reports with bullet summaries.",
          "The assistant includes the matching memory id or id prefix from the memory search result.",
          "The assistant does not substitute the unrelated PR summary preference.",
        ],
        fail: [
          "Do not answer from the unrelated PR summary memory.",
          "Do not ask the user to restate the incident report preference.",
        ],
      }),
    });

    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant answers from memory that the requester prefers incident reports with bullet summaries.",
    });
    expectMemoryIdReference(visibleAssistantText(result), match.memory.id);
    expect(await readMemories()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Prefers incident reports with bullet summaries.",
        }),
        expect.objectContaining({
          content: "Prefers terse PR summaries.",
        }),
      ]),
    );
  });

  const autoRecallThread = {
    id: "thread-memory-auto-recall",
    channel_id: "CMEMORYAUTORECALL",
    thread_ts: "17000000.memory-auto-recall",
  };

  it("automatically injects relevant memories without requiring a recall tool", async ({
    run,
  }) => {
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-auto-recall",
      thread: autoRecallThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      events: [
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

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers PR summaries with risks first.",
        scope: "personal",
      }),
    ]);
  });

  const removeThread = {
    id: "thread-memory-remove",
    channel_id: "CMEMORYREMOVE",
    thread_ts: "17000000.memory-remove",
  };

  it("removeMemory archives the selected stored memory", async ({ run }) => {
    await seedMemory({
      content: "Prefers terse PR summaries.",
      idempotencyKey: "eval-memory-remove",
      thread: removeThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Please forget that I prefer terse PR summaries.", {
          thread: removeThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant removes the matching stored memory.",
          "The assistant does not ask the user for hidden ids or scope fields.",
        ],
        fail: [
          "Do not claim the memory was removed if the assistant cannot identify the matching remembered preference.",
          "Do not ask the user for Slack ids, scope keys, or subject ids.",
        ],
      }),
    });

    expect(await readMemories()).toEqual([
      expect.objectContaining({
        archivedAtMs: expect.any(Number),
        archiveReason: "tool_removed",
        content: "Prefers terse PR summaries.",
      }),
    ]);
  });
});
