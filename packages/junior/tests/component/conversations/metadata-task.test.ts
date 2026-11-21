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
import { createLocalSource } from "@sentry/junior-plugin-api";
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
  turnId: string;
}): Promise<{ piMessages: PiMessage[]; throughSeq: number }> {
  const previousPiMessages = args.previousPiMessages ?? [];
  const turnPiMessages = piMessages(args.instruction, args.turnId);
  const allPiMessages = [...previousPiMessages, ...turnPiMessages];
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
    source: createLocalSource(args.conversationId),
    state: "completed",
    surface: "internal",
    ...(previousPiMessages.length > 0
      ? { turnStartMessageIndex: previousPiMessages.length }
      : undefined),
  });

  const { getConversationEventStore } = await import("@/chat/db");
  const messageId = `${args.turnId}:message`;
  const appended = await getConversationEventStore().append(
    args.conversationId,
    [
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
        data: {
          type: "turn_started",
          turnId: args.turnId,
          inputMessageIds: [messageId],
          surface: "internal",
        },
        createdAtMs: 2,
      },
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
  }, 30_000);
});
