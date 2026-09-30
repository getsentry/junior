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
import { setBriefsConfig } from "@/chat/briefs/registration";
import { setSpacesConfig } from "@/chat/spaces/registration";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import {
  juniorConversationBriefs,
  juniorConversationEvents,
  juniorConversationSpaces,
  juniorConversations,
  juniorSpaceChanges,
  juniorSpaces,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

const TEST = vi.hoisted(() => ({
  calls: [] as Array<{ modelId: string; prompt: string }>,
  spaceCalls: [] as Array<{ prompt: string }>,
  spaceOutputs: [] as Array<Record<string, unknown>>,
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

vi.mock("@/chat/pi/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/pi/client")>()),
  completeObject: vi.fn(
    async (input: { modelId: string; prompt: string; promptName?: string }) => {
      if (input.promptName === "junior.space_assign") {
        TEST.spaceCalls.push(input);
        const object = TEST.spaceOutputs.shift();
        if (!object) throw new Error("Missing Space classifier output");
        return { costUsd: 0.001, object };
      }
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
    },
  ),
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
    setBriefsConfig({ enabled: true });
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    fixture = await createJuniorSqlFixture();
    TEST.sql = fixture.sql;
    TEST.calls.length = 0;
    TEST.spaceCalls.length = 0;
    TEST.spaceOutputs.length = 0;
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    setBriefsConfig(undefined);
    setSpacesConfig(undefined);
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
    const { processPluginTask, scheduleSessionCompletedPluginTasks } =
      await import("@/chat/plugins/task-runner");
    const firstTask = {
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId, sessionId: "turn-1" },
    };
    const send = vi.fn();
    await scheduleSessionCompletedPluginTasks(firstTask.params, { send });
    expect(send).toHaveBeenCalledWith(firstTask);
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

    await getDb()
      .delete(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, conversationId),
          eq(juniorConversationEvents.type, "structured_event"),
        ),
      );
    await processPluginTask(firstTask);
    expect(TEST.calls).toHaveLength(1);
    expect(await getDb().select().from(juniorConversationBriefs)).toHaveLength(
      1,
    );
    expect(
      await getDb()
        .select()
        .from(juniorConversationEvents)
        .where(
          and(
            eq(juniorConversationEvents.conversationId, conversationId),
            eq(juniorConversationEvents.type, "structured_event"),
          ),
        ),
    ).toHaveLength(1);

    const secondTurn = await recordCompletedTurn({
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

    const thirdTurn = await recordCompletedTurn({
      conversationId,
      instruction: "Update the Brief after a third Turn.",
      previousPiMessages: secondTurn.piMessages,
      turnId: "turn-3",
    });
    await recordCompletedTurn({
      conversationId,
      instruction: "Update the Brief after a fourth Turn.",
      previousPiMessages: thirdTurn.piMessages,
      turnId: "turn-4",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId, sessionId: "turn-4" },
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId, sessionId: "turn-3" },
    });
    rows = await getDb()
      .select()
      .from(juniorConversationBriefs)
      .orderBy(juniorConversationBriefs.version);
    expect(TEST.calls).toHaveLength(3);
    expect(rows.map((row) => row.turnId)).toEqual([
      "turn-1",
      "turn-2",
      "turn-4",
    ]);

    const purgedConversationId = `local:briefs-purged:${idSuffix}`;
    await getConversationStore().recordActivity({
      conversationId: purgedConversationId,
      destination: {
        platform: "local",
        conversationId: purgedConversationId,
      },
      nowMs: 20,
      source: "local",
      title: "Purged private Brief",
      visibility: "private",
    });
    await recordCompletedTurn({
      conversationId: purgedConversationId,
      instruction: "Do not generate after private transcript purge.",
      turnId: "purged-turn",
    });
    await getDb()
      .update(juniorConversations)
      .set({ transcriptPurgedAt: new Date(30) })
      .where(eq(juniorConversations.conversationId, purgedConversationId));
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: {
        conversationId: purgedConversationId,
        sessionId: "purged-turn",
      },
    });
    expect(TEST.calls).toHaveLength(3);

    const { appendConversationBrief } = await import("@/chat/briefs/store");
    await expect(
      appendConversationBrief(getDb(), {
        conversationId: purgedConversationId,
        turnId: "late-turn",
        throughSeq: 1,
        content: rows[0]!.content,
        searchText: rows[0]!.searchText,
        modelId: "test-model",
      }),
    ).rejects.toThrow("purged non-public Conversation");

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
    expect(TEST.calls).toHaveLength(3);
    expect(
      await getDb()
        .select()
        .from(juniorConversationBriefs)
        .where(
          eq(juniorConversationBriefs.conversationId, childConversationId),
        ),
    ).toEqual([]);
  }, 30_000);
  it("assigns root Conversations to Spaces from their first Brief", async () => {
    setSpacesConfig({ enabled: true });
    const idSuffix = randomUUID();
    const { getConversationStore, getDb } = await import("@/chat/db");
    const { processPluginTask } = await import("@/chat/plugins/task-runner");
    const publicId = `local:spaces-public:${idSuffix}`;
    const privateId = `local:spaces-private:${idSuffix}`;
    await getConversationStore().recordActivity({
      conversationId: publicId,
      channelName: "proj-sdk",
      destination: { platform: "local", conversationId: publicId },
      nowMs: 1,
      source: "slack",
      title: "Cloudflare SDK release",
      visibility: "public",
    });
    await getConversationStore().recordActivity({
      conversationId: privateId,
      destination: { platform: "local", conversationId: privateId },
      nowMs: 2,
      source: "local",
      title: "Private SDK question",
      visibility: "private",
    });

    // A public Conversation may create the first Space.
    TEST.spaceOutputs.push({
      decision: "create",
      spaceHandle: null,
      parentHandle: null,
      name: "  SDKs ",
      description: "Work on the client SDKs.",
      confidence: 0.9,
      reason: "The Conversation is about an SDK release.",
    });
    const publicTurn = await recordCompletedTurn({
      conversationId: publicId,
      instruction: "Release the Cloudflare SDK.",
      turnId: "public-turn-1",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId: publicId, sessionId: "public-turn-1" },
    });
    expect(TEST.spaceCalls[0]?.prompt).toContain("(no Spaces yet)");
    expect(TEST.spaceCalls[0]?.prompt).toContain("Channel: proj-sdk");
    const spaces = await getDb().select().from(juniorSpaces);
    expect(spaces).toEqual([
      expect.objectContaining({
        name: "SDKs",
        description: "Work on the client SDKs.",
        createdBy: "classifier",
        parentSpaceId: null,
      }),
    ]);
    const sdkSpaceId = spaces[0]!.spaceId;
    const events = await getDb()
      .select()
      .from(juniorConversationEvents)
      .where(
        and(
          eq(juniorConversationEvents.conversationId, publicId),
          eq(juniorConversationEvents.type, "structured_event"),
        ),
      );
    expect(events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({
        namespace: "spaces",
        name: "space_assigned",
        content: expect.objectContaining({
          spaceId: sdkSpaceId,
          path: ["SDKs"],
          created: true,
          costUsd: 0.001,
        }),
      }),
    );

    // Later Turns keep the assignment without another classifier call.
    await recordCompletedTurn({
      conversationId: publicId,
      instruction: "Also update the changelog.",
      previousPiMessages: publicTurn.piMessages,
      turnId: "public-turn-2",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId: publicId, sessionId: "public-turn-2" },
    });
    expect(TEST.spaceCalls).toHaveLength(1);

    // A private Conversation cannot name a new Space. Its create proposal
    // falls back to the parent, and its reason stays out of the change log.
    TEST.spaceOutputs.push({
      decision: "create",
      spaceHandle: null,
      parentHandle: "S1",
      name: "Secret Launch",
      description: "Private plans.",
      confidence: 0.6,
      reason: "Private reason text.",
    });
    await recordCompletedTurn({
      conversationId: privateId,
      instruction: "How do I test the SDK locally?",
      turnId: "private-turn-1",
    });
    await processPluginTask({
      plugin: "briefs",
      name: "updateBrief",
      params: { conversationId: privateId, sessionId: "private-turn-1" },
    });
    expect(TEST.spaceCalls[1]?.prompt).toContain("- S1 SDKs (1)");
    expect(TEST.spaceCalls[1]?.prompt).toContain("Do not create one.");
    expect(await getDb().select().from(juniorSpaces)).toHaveLength(1);
    const assignments = await getDb()
      .select()
      .from(juniorConversationSpaces)
      .orderBy(juniorConversationSpaces.conversationId);
    expect(
      assignments.map((row) => [row.conversationId, row.spaceId, row.pinned]),
    ).toEqual(
      [
        [privateId, sdkSpaceId, false],
        [publicId, sdkSpaceId, false],
      ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    const changes = await getDb().select().from(juniorSpaceChanges);
    expect(
      changes.find((change) => change.conversationId === privateId),
    ).toMatchObject({ kind: "assign", reason: null });
    expect(
      changes.find((change) => change.conversationId === publicId),
    ).toMatchObject({
      kind: "assign",
      reason: "The Conversation is about an SDK release.",
    });

    // The next Turn sees its Space in the prompt context.
    const { getPluginUserPromptContributions } =
      await import("@/chat/plugins/agent-hooks");
    const contributions = await getPluginUserPromptContributions({
      context: {
        conversationId: publicId,
        destination: { platform: "local", conversationId: publicId },
        source: createLocalSource(publicId),
        userText: "What changed?",
      },
    });
    expect(
      contributions.find((contribution) => contribution.pluginName === "spaces")
        ?.text,
    ).toContain("This Conversation is in the Space SDKs");
  }, 30_000);
});
