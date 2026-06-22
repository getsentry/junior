import { afterEach, expect } from "vitest";
import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { closeDb, getDb } from "@/chat/db";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { juniorMemoryMemories } from "../../../junior-memory/src/db/schema";
import { mention, rubric, slackEvals } from "../../src/helpers";

const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";
const requesterUserId = "U-test";

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

function expectVisibleMemoryId(text: string, id: string): void {
  const parts = text.match(/\bmem_[a-zA-Z0-9_-]+\b/g) ?? [];
  expect(parts.some((part) => id.startsWith(part) && part.length >= 12)).toBe(
    true,
  );
}

function expectCanonicalMemoryContent(
  content: string,
  expectedPattern: RegExp,
): void {
  expect(content).toMatch(expectedPattern);
  expect(content).not.toMatch(
    /\b(the requester|the user|requester|user|David|this thread|this channel|channel|Slack|I|my)\b/i,
  );
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

    const createCall = toolCalls(result.session).find(
      (call) => call.name === "createMemory",
    );
    expect(createCall?.arguments).toEqual(
      expect.objectContaining({
        content: expect.stringMatching(/\bterse\b.*\bPR summaries\b/i),
      }),
    );
    expect(await readMemories()).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        content: expect.stringMatching(/^Prefers terse PR summaries\.?$/i),
        scope: "personal",
        subjectType: "user",
      }),
    ]);
    const rows = await readMemories();
    expectCanonicalMemoryContent(
      rows[0]!.content,
      /^Prefers terse PR summaries\.?$/i,
    );
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

    expect(visibleAssistantText(result)).toMatch(
      /\bterse\b.*\bPR summaries\b/i,
    );
    expectVisibleMemoryId(visibleAssistantText(result), seeded.memory.id);
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

    expect(visibleAssistantText(result)).toMatch(
      /\bincident reports\b.*\bbullet summaries\b/i,
    );
    expectVisibleMemoryId(visibleAssistantText(result), match.memory.id);
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
