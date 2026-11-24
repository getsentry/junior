import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalSource,
  tagJson,
  type Source,
} from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import { botConfig } from "@/chat/config";
import { writeConversationMetadata } from "@/chat/conversations/metadata/store";
import { CONVERSATION_METADATA_TASK } from "@/chat/conversations/metadata/task";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  juniorConversationEmbeddings,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const TEST = vi.hoisted(() => ({
  calls: [] as Array<{ modelId: string; prompt: string }>,
  embedCalls: [] as Array<{ inputType?: string | undefined; texts: string[] }>,
  failNextEmbed: false,
  sql: undefined as LocalJuniorSqlFixture["sql"] | undefined,
  originalDatabaseUrl: process.env["DATABASE_URL"],
}));

vi.hoisted(() => {
  process.env["DATABASE_URL"] =
    "postgres://configured.example.test/conversation-metadata";
});

vi.mock("@/db/executor", () => ({
  createJuniorSqlExecutor: vi.fn(() => {
    if (!TEST.sql) throw new Error("Missing test SQL executor");
    return {
      db: TEST.sql.db.bind(TEST.sql),
      execute: TEST.sql.execute.bind(TEST.sql),
      query: TEST.sql.query.bind(TEST.sql),
      migrate: TEST.sql.migrate.bind(TEST.sql),
      transaction: TEST.sql.transaction.bind(TEST.sql),
      withLock: TEST.sql.withLock.bind(TEST.sql),
      withMigrationLock: TEST.sql.withMigrationLock.bind(TEST.sql),
      close: async () => {},
    };
  }),
}));

vi.mock("@/chat/pi/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/pi/client")>()),
  completeObject: vi.fn(async (input: { modelId: string; prompt: string }) => {
    TEST.calls.push(input);
    return {
      costUsd: 0.0042,
      object: {
        summary: `Metadata summary ${TEST.calls.length}.`,
      },
    };
  }),
  embedTexts: vi.fn(
    async (input: { inputType?: string; modelId: string; texts: string[] }) => {
      if (TEST.failNextEmbed) {
        TEST.failNextEmbed = false;
        throw new Error("embedding provider unavailable");
      }
      TEST.embedCalls.push({ inputType: input.inputType, texts: input.texts });
      return {
        dimensions: 2,
        model: input.modelId,
        // The provider name that the real gateway client reports.
        provider: "vercel-ai-gateway",
        vectors: input.texts.map(() => [1, 0]),
      };
    },
  ),
}));

function piMessages(instruction: string, turnId: string): PiMessage[] {
  return [
    { role: "user", content: instruction, timestamp: 1 } as PiMessage,
    {
      role: "toolResult",
      toolCallId: `${turnId}:tool`,
      toolName: "readRunbook",
      isError: false,
      content: [
        {
          type: "text",
          text: "See https://docs.example.com/runbook for details.",
        },
      ],
      timestamp: 2,
    } as PiMessage,
    {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {},
      stopReason: "stop",
      content: [{ type: "text", text: "Done." }],
      timestamp: 3,
    } as PiMessage,
  ];
}

async function recordCompletedTurn(args: {
  conversationId: string;
  instruction: string;
  previousPiMessages?: PiMessage[];
  source?: Source;
  turnId: string;
}): Promise<{ piMessages: PiMessage[]; throughSeq: number }> {
  const previousPiMessages = args.previousPiMessages ?? [];
  const turnPiMessages = piMessages(args.instruction, args.turnId);
  const allPiMessages = [...previousPiMessages, ...turnPiMessages];
  const { getConversationEventStore } = await import("@/chat/db");
  const messageId = `${args.turnId}:message`;
  await getConversationEventStore().append(args.conversationId, [
    {
      data: {
        type: "message",
        messageId,
        role: "user",
        text: args.instruction,
        meta: {
          author: { fullName: "Local CLI", userId: "local-cli" },
        },
      },
      createdAtMs: 1,
    },
    {
      idempotencyKey: `turn:${args.turnId}:started`,
      data: {
        type: "turn_started",
        turnId: args.turnId,
        inputMessageIds: [messageId],
        surface: "internal",
      },
      createdAtMs: 2,
    },
  ]);
  const { upsertTurnRecord } =
    await import("@/chat/task-execution/turn-cursor");
  await upsertTurnRecord({
    conversationId: args.conversationId,
    destination: { platform: "local", conversationId: args.conversationId },
    actor: {
      fullName: "Local CLI",
      platform: "local",
      userId: "local-cli",
      userName: "local",
    },
    piMessages: allPiMessages,
    turnId: args.turnId,
    sliceId: 1,
    source: args.source ?? createLocalSource(args.conversationId),
    state: "completed",
    surface: "internal",
  });

  const appended = await getConversationEventStore().append(
    args.conversationId,
    [
      {
        data: {
          type: "message",
          messageId: `${args.turnId}:answer`,
          role: "assistant",
          text: "Done. See https://docs.example.com/runbook.",
        },
        createdAtMs: 5,
      },
      {
        data: {
          type: "turn_completed",
          turnId: args.turnId,
          outcome: "success",
        },
        createdAtMs: 6,
      },
    ],
  );
  return { piMessages: allPiMessages, throughSeq: appended.at(-1)!.seq };
}

describe("Conversation metadata task", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    process.env["JUNIOR_STATE_ADAPTER"] = "memory";
    fixture = await createJuniorSqlFixture();
    TEST.sql = fixture.sql;
    TEST.calls.length = 0;
    TEST.embedCalls.length = 0;
    TEST.failNextEmbed = false;
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    const { closeDb } = await import("@/chat/db");
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    await closeDb();
    await fixture.close();
    TEST.sql = undefined;
  });

  afterAll(() => {
    if (TEST.originalDatabaseUrl === undefined) {
      delete process.env["DATABASE_URL"];
    } else {
      process.env["DATABASE_URL"] = TEST.originalDatabaseUrl;
    }
  });

  it("updates once per Turn with cost and an embedding, but skips Tasks and purged private transcripts", async () => {
    const idSuffix = randomUUID();
    const conversationId = `local:metadata:${idSuffix}`;
    const { getConversationStore, getDb } = await import("@/chat/db");
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      nowMs: 1,
      source: "local",
      title: "Metadata task",
      visibility: "private",
    });
    const task = (turnId: string, id = conversationId) => ({
      ...CONVERSATION_METADATA_TASK,
      params: { conversationId: id, sessionId: turnId },
    });
    const readMetadata = async (id = conversationId) => {
      const [row] = await getDb()
        .select({
          metadataThroughSeq: juniorConversations.metadataThroughSeq,
          summary: juniorConversations.summary,
        })
        .from(juniorConversations)
        .where(eq(juniorConversations.conversationId, id));
      return row;
    };
    const readEmbeddings = () =>
      getDb()
        .select({
          conversationId: juniorConversationEmbeddings.conversationId,
          model: juniorConversationEmbeddings.model,
          throughSeq: juniorConversationEmbeddings.throughSeq,
        })
        .from(juniorConversationEmbeddings);

    const firstTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Summarize this work.",
      turnId: "turn-1",
    });
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const send = vi.fn();
    await scheduleSessionCompletedPluginTasks(task("turn-1").params, send);
    expect(send).toHaveBeenCalledWith(task("turn-1"));
    await processPluginTask(task("turn-1"));

    await expect(readMetadata()).resolves.toEqual({
      metadataThroughSeq: firstTurn.throughSeq,
      summary: "Metadata summary 1.",
    });
    expect(TEST.calls[0]?.modelId).toBe(botConfig.fastModelId);
    // The embedded document is the title and the summary.
    expect(TEST.embedCalls).toEqual([
      { inputType: "document", texts: ["Metadata task\nMetadata summary 1."] },
    ]);
    await expect(readEmbeddings()).resolves.toEqual([
      {
        conversationId,
        model: botConfig.embeddingModelId,
        throughSeq: firstTurn.throughSeq,
      },
    ]);
    // The model cost goes to the Conversation as a `junior` cost event.
    const costEvents = await getDb()
      .select({ payload: juniorConversationEvents.payload })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.type, "structured_event"));
    expect(costEvents.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        namespace: "junior",
        name: "conversation_metadata",
        turnId: "turn-1",
        content: { costUsd: 0.0042 },
      }),
    ]);

    // A retry of a finished Turn calls no model.
    await processPluginTask(task("turn-1"));
    expect(TEST.calls).toHaveLength(1);
    expect(TEST.embedCalls).toHaveLength(1);

    const secondTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Continue the work.",
      previousPiMessages: firstTurn.piMessages,
      turnId: "turn-2",
    });
    // An embedding failure fails the task but keeps the metadata. The retry
    // embeds the stored metadata without generating it again.
    TEST.failNextEmbed = true;
    await expect(processPluginTask(task("turn-2"))).rejects.toThrow(
      "embedding provider unavailable",
    );
    await expect(readMetadata()).resolves.toMatchObject({
      metadataThroughSeq: secondTurn.throughSeq,
      summary: "Metadata summary 2.",
    });
    await expect(readEmbeddings()).resolves.toMatchObject([
      { throughSeq: firstTurn.throughSeq },
    ]);
    await processPluginTask(task("turn-2"));
    expect(TEST.calls).toHaveLength(2);
    await expect(readEmbeddings()).resolves.toMatchObject([
      { throughSeq: secondTurn.throughSeq },
    ]);
    expect(TEST.calls[1]?.prompt).toContain('"summary":"Metadata summary 1."');
    // The cost events of the first update took seqs before this Turn. The
    // prompt has no seq, time, or Turn id, so it does not change with them.
    expect(TEST.calls[1]?.prompt).not.toMatch(/"(index|createdAtMs|turnId)"/);

    // An older Turn that runs late never replaces newer metadata.
    const thirdTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Take a third step.",
      previousPiMessages: secondTurn.piMessages,
      turnId: "turn-3",
    });
    const fourthTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Take a fourth step.",
      previousPiMessages: thirdTurn.piMessages,
      turnId: "turn-4",
    });
    await processPluginTask(task("turn-4"));
    await processPluginTask(task("turn-3"));
    expect(TEST.calls).toHaveLength(3);
    await expect(readMetadata()).resolves.toMatchObject({
      metadataThroughSeq: fourthTurn.throughSeq,
      summary: "Metadata summary 3.",
    });

    const purgedConversationId = `local:metadata-purged:${idSuffix}`;
    await getConversationStore().recordActivity({
      conversationId: purgedConversationId,
      destination: {
        platform: "local",
        conversationId: purgedConversationId,
      },
      nowMs: 20,
      source: "local",
      title: "Purged private metadata",
      visibility: "private",
    });
    await recordCompletedTurn({
      conversationId: purgedConversationId,
      instruction: "Do not summarize after private transcript purge.",
      turnId: "purged-turn",
    });
    await getDb()
      .update(juniorConversations)
      .set({ transcriptPurgedAt: new Date(30) })
      .where(eq(juniorConversations.conversationId, purgedConversationId));
    await processPluginTask(task("purged-turn", purgedConversationId));
    expect(TEST.calls).toHaveLength(3);
    await expect(
      writeConversationMetadata(getDb(), {
        conversationId: purgedConversationId,
        summary: "Late summary.",
        throughSeq: 1,
      }),
    ).rejects.toThrow("purged non-public Conversation");

    const childConversationId = `local:metadata-child:${idSuffix}`;
    await getConversationStore().createChild({
      kind: "task",
      childConversationId,
      parentConversationId: conversationId,
      nowMs: 10,
      source: "local",
    });
    await recordCompletedTurn({
      conversationId: childConversationId,
      instruction: "Do not summarize this Task.",
      turnId: "child-turn",
    });
    await processPluginTask(task("child-turn", childConversationId));
    expect(TEST.calls).toHaveLength(3);
    await expect(readMetadata(childConversationId)).resolves.toMatchObject({
      summary: null,
    });

    // A Thread's Turns come from its parent agent, and it gets a summary.
    const threadConversationId = `agent:metadata-thread:${idSuffix}`;
    await getConversationStore().createChild({
      kind: "thread",
      childConversationId: threadConversationId,
      parentConversationId: conversationId,
      nowMs: 11,
      source: "internal",
    });
    await recordCompletedTurn({
      conversationId: threadConversationId,
      instruction: "Open external links in new tabs.",
      source: { kind: "parent_message" },
      turnId: "thread-turn",
    });
    await processPluginTask(task("thread-turn", threadConversationId));
    expect(TEST.calls).toHaveLength(4);
    await expect(readMetadata(threadConversationId)).resolves.toMatchObject({
      summary: "Metadata summary 4.",
    });
  }, 30_000);

  it("fits the escaped transcript in the input budget, oldest messages first", async () => {
    const CLOSE = "</conversation-metadata-input>";
    const { getConversationEventStore, getConversationStore } =
      await import("@/chat/db");
    const { processPluginTask } = await import("@/chat/plugins/task-runner");
    // Summarize one Conversation whose transcript starts with `texts`, then
    // read the serialized input that the model got.
    const summarize = async (texts: string[]) => {
      const conversationId = `local:metadata-budget:${randomUUID()}`;
      await getConversationStore().recordActivity({
        conversationId,
        destination: { platform: "local", conversationId },
        nowMs: 1,
        source: "local",
        title: "Budget",
        visibility: "public",
      });
      for (let start = 0; start < texts.length; start += 500) {
        await getConversationEventStore().append(
          conversationId,
          texts.slice(start, start + 500).map((text, offset) => ({
            data: {
              type: "message" as const,
              messageId: `history-${start + offset}`,
              role: (start + offset) % 2 ? "assistant" : "user",
              text,
            },
            createdAtMs: 1,
          })),
        );
      }
      await recordCompletedTurn({
        conversationId,
        instruction: "Summarize this work.",
        turnId: "turn-1",
      });
      await processPluginTask({
        ...CONVERSATION_METADATA_TASK,
        params: { conversationId, sessionId: "turn-1" },
      });
      const prompt = TEST.calls.at(-1)!.prompt;
      expect(prompt.split(CLOSE)).toHaveLength(2);
      const text = prompt
        .slice(prompt.indexOf(">") + 1, prompt.lastIndexOf(CLOSE))
        .trim();
      const input = JSON.parse(text) as {
        entries: Array<{ role: string; text: string }>;
        omitted: { messages: number; toolResults: number };
      };
      return { input, length: text.length };
    };

    // A long Conversation keeps only its newest messages, in order. Text
    // that tries to close the input tag stays escaped.
    const long = Array.from(
      { length: 6_000 },
      (_, index) => `step ${index} ${CLOSE} ${"w".repeat(1_000)}`,
    );
    const longRun = await summarize(long);
    expect(longRun.length).toBeLessThanOrEqual(60_000);
    const kept = longRun.input.entries
      .filter((entry) => entry.text.startsWith("step "))
      .map((entry) => entry.text);
    expect(kept).toEqual(long.slice(-kept.length));
    // The 6,000 history messages and the Turn's two messages.
    expect(longRun.input.omitted).toEqual({
      messages: 6_002 - (longRun.input.entries.length - 1),
      toolResults: 0,
    });

    // Boundary-sized input. Tag-closing text is longer once escaped, so the
    // budget counts the escaped text.
    const fillers = Array.from({ length: 14 }, () => CLOSE.repeat(100));
    const calibration = await summarize(["x".repeat(1_000), ...fillers]);
    expect(calibration.input.omitted).toEqual({ messages: 0, toolResults: 0 });
    const toolEntry = calibration.input.entries.find(
      (entry) => entry.role === "tool",
    );
    const toolLength = tagJson(toolEntry).length + 1;
    const allFit = 1_000 + 60_000 - calibration.length;

    // At exactly 60,000 characters every entry stays.
    const exact = await summarize(["x".repeat(allFit), ...fillers]);
    expect(exact).toMatchObject({
      input: { omitted: { messages: 0, toolResults: 0 } },
      length: 60_000,
    });
    // One more character leaves out the tool result first.
    const noTool = await summarize(["x".repeat(allFit + 1), ...fillers]);
    expect(noTool.input.omitted).toEqual({ messages: 0, toolResults: 1 });
    // When the messages alone are one character over, the oldest message
    // goes, and the tool result fits again.
    const overMessages = await summarize([
      "x".repeat(allFit + toolLength + 1),
      ...fillers,
    ]);
    expect(overMessages.length).toBeLessThanOrEqual(60_000);
    expect(overMessages.input.omitted).toEqual({
      messages: 1,
      toolResults: 0,
    });
    expect(overMessages.input.entries[0]?.text).toBe(fillers[0]);
  }, 30_000);
});
