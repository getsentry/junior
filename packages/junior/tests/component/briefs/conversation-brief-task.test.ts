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
  type CodeChangeInput,
} from "@sentry/junior-plugin-api";
import type { PiMessage } from "@/chat/pi/messages";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  juniorConversationBriefs,
  juniorConversationEvents,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  createLocalJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const TEST = vi.hoisted(() => ({
  calls: [] as Array<{ modelId: string; prompt: string }>,
  sql: undefined as LocalJuniorSqlFixture["sql"] | undefined,
  originalDatabaseUrl: process.env.DATABASE_URL,
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgres://configured.example.test/briefs";
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

vi.mock("@/chat/pi/client", () => ({
  completeObject: vi.fn(async (input: { modelId: string; prompt: string }) => {
    TEST.calls.push(input);
    return {
      costUsd: 0.0042,
      object: {
        summary: `Brief summary ${TEST.calls.length}.`,
        intent: "Record the completed implementation.",
        outcome: { status: "done", text: "The implementation is complete." },
        decisions: [
          {
            text: "Use durable Brief versions.",
            by: "Local CLI",
            kind: "stated",
          },
        ],
        openDecisions: [],
        facts: ["The task stores one version per Turn."],
        keywords: ["briefs", "storage"],
        urls: [
          { label: "Runbook", url: "https://docs.example.com/runbook" },
          { label: "Invented", url: "https://invented.example.com" },
        ],
      },
    };
  }),
  embedTexts: vi.fn(),
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

describe("Conversation Brief task", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    fixture = await createLocalJuniorSqlFixture();
    TEST.sql = fixture.sql;
    TEST.calls.length = 0;
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
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = TEST.originalDatabaseUrl;
    }
  });

  it("stores idempotent versions with evidence, cost, and previous context, but skips children", async () => {
    const idSuffix = randomUUID();
    const conversationId = `local:briefs:${idSuffix}`;
    const { getConversationStore, getDb } = await import("@/chat/db");
    await getConversationStore().recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      nowMs: 1,
      source: "local",
      title: "Brief storage task",
      visibility: "private",
    });
    const { createPluginAnnotations } =
      await import("@/chat/plugins/annotations");
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "test",
    }).upsert({
      kind: "resource_link",
      key: "issue",
      label: "Tracked issue",
      url: "https://issues.example.com/123",
      status: "open",
    });
    const { recordCodeChange } = await import("@/chat/code/store");
    const now = new Date("2026-09-09T12:00:00.000Z");
    await recordCodeChange(getDb(), "github", {
      conversationIds: [conversationId],
      number: 1805,
      openedAt: now,
      providerId: "briefs-pr",
      repository: {
        name: "getsentry/junior",
        providerId: "junior-repo",
        url: "https://github.com/getsentry/junior",
      },
      state: "open",
      title: "Add Conversation Brief storage",
      updatedAt: now,
      url: "https://github.com/getsentry/junior/pull/1805",
    } satisfies CodeChangeInput);

    const firstTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Store a durable Brief for this work.",
      turnId: "turn-1",
    });
    const { processPluginTask } = await import("@/chat/plugins/task-runner");
    const firstTask = {
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId, sessionId: "turn-1" },
    };
    await processPluginTask(firstTask);

    let rows = await getDb()
      .select()
      .from(juniorConversationBriefs)
      .orderBy(juniorConversationBriefs.version);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversationId,
      version: 1,
      turnId: "turn-1",
      throughSeq: firstTurn.throughSeq,
      modelId: TEST.calls[0]?.modelId,
      costUsd: 0.0042,
    });
    expect(rows[0]?.searchText).not.toBe("");
    expect(rows[0]?.content.links).toEqual([
      expect.objectContaining({
        kind: "code_change",
        url: "https://github.com/getsentry/junior/pull/1805",
      }),
      expect.objectContaining({
        kind: "resource",
        url: "https://issues.example.com/123",
      }),
      {
        kind: "url",
        label: "Runbook",
        url: "https://docs.example.com/runbook",
      },
    ]);

    const structuredEvents = await getDb()
      .select()
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.type, "structured_event"));
    expect(structuredEvents).toHaveLength(1);
    expect(structuredEvents[0]?.payload).toMatchObject({
      namespace: "briefs",
      name: "brief_updated",
      content: {
        version: 1,
        modelId: TEST.calls[0]?.modelId,
        costUsd: 0.0042,
        decisions: 1,
        openDecisions: 0,
        links: 3,
      },
    });
    const { readConversationAuxiliaryCostsFromSql } =
      await import("@/api/conversations/auxiliary-costs");
    await expect(
      readConversationAuxiliaryCostsFromSql(getDb(), [conversationId], {
        includeDescendants: false,
      }),
    ).resolves.toEqual(
      new Map([
        [
          conversationId,
          {
            costUsd: 0.0042,
            operations: [
              {
                namespace: "briefs",
                name: "brief_updated",
                events: 1,
                costUsd: 0.0042,
              },
            ],
          },
        ],
      ]),
    );

    await processPluginTask(firstTask);
    expect(TEST.calls).toHaveLength(1);
    expect(await getDb().select().from(juniorConversationBriefs)).toHaveLength(
      1,
    );

    await recordCompletedTurn({
      conversationId,
      instruction: "Update the Brief after a second Turn.",
      previousPiMessages: firstTurn.piMessages,
      turnId: "turn-2",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId, sessionId: "turn-2" },
    });
    rows = await getDb()
      .select()
      .from(juniorConversationBriefs)
      .orderBy(juniorConversationBriefs.version);
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
    expect(TEST.calls[1]?.prompt).toContain('"summary":"Brief summary 1."');

    const childConversationId = `local:briefs-child:${idSuffix}`;
    await getConversationStore().createChild({
      childConversationId,
      parentConversationId: conversationId,
      nowMs: 10,
      source: "local",
    });
    await recordCompletedTurn({
      conversationId: childConversationId,
      instruction: "Do not create a Brief for this child.",
      turnId: "child-turn",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: {
        conversationId: childConversationId,
        sessionId: "child-turn",
      },
    });
    expect(TEST.calls).toHaveLength(2);
    expect(
      await getDb()
        .select()
        .from(juniorConversationBriefs)
        .where(
          eq(juniorConversationBriefs.conversationId, childConversationId),
        ),
    ).toEqual([]);
  }, 30_000);
});
