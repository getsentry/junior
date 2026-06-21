import { afterEach, expect } from "vitest";
import { assistantMessages, describeEval, toolCalls } from "vitest-evals";
import { getChatConfig } from "@/chat/config";
import {
  closeConfiguredPluginDb,
  createPluginDbForExecutor,
} from "@/chat/plugins/db";
import { createJuniorSqlExecutor } from "@/chat/sql/executor";
import type { JuniorSqlExecutor } from "@/chat/sql/db";
import { createMemoryStore } from "@sentry/junior-memory";
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

function createEvalSqlExecutor(): JuniorSqlExecutor {
  const { sql } = getChatConfig();
  if (!sql.databaseUrl) {
    throw new Error(
      "Memory evals require DATABASE_URL from the Junior Postgres test setup.",
    );
  }
  return createJuniorSqlExecutor({
    connectionString: sql.databaseUrl,
    driver: sql.driver,
  });
}

async function withMemoryDb<T>(
  callback: (executor: JuniorSqlExecutor) => Promise<T>,
): Promise<T> {
  const executor = createEvalSqlExecutor();
  try {
    return await callback(executor);
  } finally {
    await closeConfiguredPluginDb();
    await executor.close();
  }
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
  executor: JuniorSqlExecutor;
  idempotencyKey: string;
  scope?: "conversation" | "personal";
  thread: MemoryThread;
}) {
  const store = createMemoryStore(
    createPluginDbForExecutor(args.executor),
    memoryContext(args.thread),
  );
  const input = {
    content: args.content,
    idempotencyKey: args.idempotencyKey,
  };
  if (args.scope === "conversation") {
    return await store.createConversationMemory(input);
  }
  return await store.createMemory(input);
}

async function readMemories(executor: JuniorSqlExecutor) {
  const db = createPluginDbForExecutor(executor);
  return await db
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

afterEach(async () => {
  await closeConfiguredPluginDb();
});

describeEval("Memory Workflows", slackEvals, (it) => {
  const explicitRememberThread = {
    id: "thread-memory-explicit-remember",
    channel_id: "CMEMORYEXPLICIT",
    thread_ts: "17000000.memory-explicit",
  };

  it("createMemory submits only a memory candidate and does not write a rejected memory", async ({
    run,
  }) => {
    await withMemoryDb(async (executor) => {
      const result = await run({
        overrides: memoryPluginOverrides,
        events: [
          mention("Please remember that I prefer terse PR summaries.", {
            thread: explicitRememberThread,
          }),
        ],
        criteria: rubric({
          pass: [
            "Judge only the visible assistant reply for this case; the test separately checks database writes.",
            "The assistant treats this as an explicit memory request or explains that it could not remember the preference.",
            "The assistant does not ask the user to provide hidden scope, actor, Slack, or subject identifiers.",
          ],
          fail: [
            "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
            "Do not visibly claim the memory was definitely saved unless the assistant has confirmed the memory was accepted.",
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
      expect(await readMemories(executor)).toHaveLength(0);
    });
  });

  const listThread = {
    id: "thread-memory-list",
    channel_id: "CMEMORYLIST",
    thread_ts: "17000000.memory-list",
  };

  it("listMemories reads visible memories before answering what Junior remembers", async ({
    run,
  }) => {
    await withMemoryDb(async (executor) => {
      const seeded = await seedMemory({
        content: "The requester prefers terse PR summaries.",
        executor,
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
            "The assistant lists the stored memory that the requester prefers terse PR summaries.",
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
      expect(await readMemories(executor)).toEqual([
        expect.objectContaining({
          archivedAtMs: null,
          content: "The requester prefers terse PR summaries.",
          scope: "personal",
        }),
      ]);
    });
  });

  const searchThread = {
    id: "thread-memory-search",
    channel_id: "CMEMORYSEARCH",
    thread_ts: "17000000.memory-search",
  };

  it("searchMemories finds the relevant stored memory for a targeted recall request", async ({
    run,
  }) => {
    await withMemoryDb(async (executor) => {
      const match = await seedMemory({
        content:
          "The requester prefers incident reports with bullet summaries.",
        executor,
        idempotencyKey: "eval-memory-search-match",
        thread: searchThread,
      });
      await seedMemory({
        content: "The requester prefers terse PR summaries.",
        executor,
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
            "The assistant answers from memory that the requester likes incident reports with bullet summaries.",
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
      expect(await readMemories(executor)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content:
              "The requester prefers incident reports with bullet summaries.",
          }),
          expect.objectContaining({
            content: "The requester prefers terse PR summaries.",
          }),
        ]),
      );
    });
  });

  const autoRecallThread = {
    id: "thread-memory-auto-recall",
    channel_id: "CMEMORYAUTORECALL",
    thread_ts: "17000000.memory-auto-recall",
  };

  it("automatically injects relevant memories without requiring a recall tool", async ({
    run,
  }) => {
    await withMemoryDb(async (executor) => {
      await seedMemory({
        content: "The requester prefers PR summaries with risks first.",
        executor,
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
            "The assistant uses memory to say the requester prefers PR summaries with risks first.",
            "The assistant does not ask the user to restate the preference.",
          ],
          fail: [
            "Do not answer as if no relevant preference exists.",
            "Do not mention hidden storage fields, scope keys, or Slack ids.",
          ],
        }),
      });

      expect(await readMemories(executor)).toEqual([
        expect.objectContaining({
          archivedAtMs: null,
          content: "The requester prefers PR summaries with risks first.",
          scope: "personal",
        }),
      ]);
    });
  });

  const removeThread = {
    id: "thread-memory-remove",
    channel_id: "CMEMORYREMOVE",
    thread_ts: "17000000.memory-remove",
  };

  it("removeMemory archives the selected stored memory", async ({ run }) => {
    await withMemoryDb(async (executor) => {
      await seedMemory({
        content: "The requester prefers terse PR summaries.",
        executor,
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

      expect(await readMemories(executor)).toEqual([
        expect.objectContaining({
          archivedAtMs: expect.any(Number),
          archiveReason: "tool_removed",
          content: "The requester prefers terse PR summaries.",
        }),
      ]);
    });
  });
});
