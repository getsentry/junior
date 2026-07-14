import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RedisStateAdapter } from "@chat-adapter/state-redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChatConfig } from "@/chat/config";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  appendInboundMessage,
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createSqlAgentStepStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { ConversationStore } from "@/chat/conversations/store";
import type { PiMessage } from "@/chat/pi/messages";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { recordAgentTurnSessionSummary } from "@/chat/state/turn-session";
import { resolveUpgradePluginSet } from "@/cli/upgrade";
import { agentTurnSessionActorMigration } from "@/cli/upgrade/migrations/agent-turn-session-actor";
import { repairConversationUsage } from "@/cli/upgrade/migrations/conversation-usage";
import { migrateConversationsToSql } from "@/cli/upgrade/migrations/conversations-sql";
import { redisConversationStateMigration } from "@/cli/upgrade/migrations/redis-conversation-state";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  inboundMessage,
} from "../../fixtures/conversation-work";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const ORIGINAL_ENV = vi.hoisted(() => {
  const original = {
    DATABASE_URL: process.env.DATABASE_URL,
    JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
  };
  process.env.DATABASE_URL = "postgres://configured.example.test/neon";
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  return original;
});
const ORIGINAL_CWD = process.cwd();
const OTHER_SLACK_DESTINATION = {
  ...SLACK_DESTINATION,
  channelId: "C999",
} as const;

const stateOnlyConversationStore: ConversationStore = {
  get: async () => undefined,
  getDestinationVisibility: async () => undefined,
  recordActivity: async () => {},
  ensureChildConversation: async () => {},
  recordExecution: async () => {},
  listByActivity: async () => [],
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function persistActiveTurn(
  conversationId: string,
  activeTurnId?: string,
): Promise<void> {
  await persistThreadStateById(conversationId, {
    conversation: {
      schemaVersion: 1,
      backfill: {},
      compactions: [],
      messages: [],
      processing: {
        activeTurnId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 0,
        updatedAtMs: 2_000,
      },
      vision: {
        byFileId: {},
      },
    },
  });
}

describe("upgrade CLI migrations", () => {
  beforeEach(async () => {
    process.env.DATABASE_URL = "postgres://configured.example.test/neon";
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    process.chdir(ORIGINAL_CWD);
    await disconnectStateAdapter();
    restoreEnv("DATABASE_URL", ORIGINAL_ENV.DATABASE_URL);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("loads source app plugins for upgrade when virtual config is unavailable", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-upgrade-plugins-"));
    writeFileSync(
      path.join(tempDir, "plugins.ts"),
      `const packageNames: string[] = ["@acme/junior-upgrade"];

export const plugins = {
  packageNames,
  registrations: [],
};
`,
    );
    process.chdir(tempDir);

    try {
      await expect(resolveUpgradePluginSet()).resolves.toMatchObject({
        packageNames: ["@acme/junior-upgrade"],
        registrations: [],
      });
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("migrates legacy requester fields in turn-session state", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const conversationId = "slack:C123:legacy-actor";
    const sessionId = "turn-legacy-actor";
    const requester = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
      userName: "alice",
    };
    const summary = {
      version: 1,
      conversationId,
      cumulativeDurationMs: 0,
      lastProgressAtMs: 2,
      requester,
      sessionId,
      sliceId: 1,
      startedAtMs: 1,
      state: "completed",
      updatedAtMs: 3,
    };

    await stateAdapter.appendToList(
      "junior:agent_turn_session:index",
      summary,
      { ttlMs: 60_000 },
    );
    await stateAdapter.appendToList(
      `junior:agent_turn_session:conversation:${conversationId}:index`,
      summary,
      { ttlMs: 60_000 },
    );
    await stateAdapter.set(
      `junior:agent_turn_session:${conversationId}:${sessionId}`,
      { ...summary, committedSeq: -1 },
      60_000,
    );

    await expect(
      agentTurnSessionActorMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 0,
      migrated: 3,
      missing: 0,
      scanned: 3,
    });

    const { listBoundedAgentTurnSessionSummariesForConversation } =
      await import("@/chat/state/turn-session");
    await expect(
      listBoundedAgentTurnSessionSummariesForConversation(conversationId),
    ).resolves.toEqual([
      expect.objectContaining({ actor: requester, sessionId }),
    ]);
    const migratedRecord = await stateAdapter.get(
      `junior:agent_turn_session:${conversationId}:${sessionId}`,
    );
    expect(migratedRecord).toEqual(
      expect.objectContaining({ actor: requester }),
    );
    expect(migratedRecord).not.toHaveProperty("requester");

    await expect(
      agentTurnSessionActorMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 1,
      migrated: 0,
      missing: 0,
      scanned: 3,
    });
  });

  it("discovers legacy turn sessions outside the bounded global index", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const conversationId = "slack:C123:older-legacy-actor";
    const sessionId = "turn-older-legacy-actor";
    const requester = {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    };
    const summary = {
      version: 1,
      conversationId,
      cumulativeDurationMs: 0,
      lastProgressAtMs: 2,
      requester,
      sessionId,
      sliceId: 1,
      startedAtMs: 1,
      state: "completed",
      updatedAtMs: 3,
    };

    await stateAdapter.appendToList(
      `junior:agent_turn_session:conversation:${conversationId}:index`,
      summary,
      { ttlMs: 60_000 },
    );
    await stateAdapter.set(
      `junior:agent_turn_session:${conversationId}:${sessionId}`,
      { ...summary, committedSeq: -1 },
      60_000,
    );

    const statePrefix = getChatConfig().state.keyPrefix;
    const redisConversationIndexKey = [
      "chat-sdk:list",
      ...(statePrefix ? [statePrefix] : []),
      `junior:agent_turn_session:conversation:${conversationId}:index`,
    ].join(":");
    const redisStateAdapter = {
      getClient: () => ({
        sendCommand: async (args: readonly string[]) => {
          expect(args).toEqual([
            "SCAN",
            "0",
            "MATCH",
            `*:list:${statePrefix ? `${statePrefix}:` : ""}junior:agent_turn_session:conversation:*:index`,
            "COUNT",
            "500",
          ]);
          return ["0", [redisConversationIndexKey]];
        },
      }),
    } as unknown as RedisStateAdapter;

    await expect(
      agentTurnSessionActorMigration.run({
        io: { info: () => {} },
        redisStateAdapter,
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 0,
      migrated: 2,
      missing: 0,
      scanned: 2,
    });

    const { listBoundedAgentTurnSessionSummariesForConversation } =
      await import("@/chat/state/turn-session");
    await expect(
      listBoundedAgentTurnSessionSummariesForConversation(conversationId),
    ).resolves.toEqual([
      expect.objectContaining({ actor: requester, sessionId }),
    ]);
    await expect(
      stateAdapter.get(
        `junior:agent_turn_session:${conversationId}:${sessionId}`,
      ),
    ).resolves.toEqual(expect.objectContaining({ actor: requester }));
  });

  it("migrates legacy conversation work before SQL conversation backfill", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const legacyMessage = inboundMessage("legacy-sql");
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        messages: [legacyMessage],
        needsRun: true,
        updatedAtMs: 2_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const context = {
        io: { info: () => {} },
        stateAdapter,
      };
      const results = [
        await redisConversationStateMigration.run(context),
        await migrateConversationsToSql(context, { target: sqlStore }),
      ];

      expect(results).toEqual([
        {
          existing: 0,
          migrated: 1,
          missing: 0,
          scanned: 1,
        },
        {
          existing: 0,
          migrated: 1,
          missing: 0,
          scanned: 1,
        },
      ]);
      await expect(
        stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
      ).resolves.toMatchObject({
        conversationId: CONVERSATION_ID,
        execution: {
          inboundMessageIds: ["legacy-sql"],
          pendingCount: 1,
          status: "pending",
        },
      });
      const sqlConversation = await sqlStore.get({
        conversationId: CONVERSATION_ID,
      });
      expect(sqlConversation).toMatchObject({
        conversationId: CONVERSATION_ID,
        execution: {
          status: "pending",
        },
      });
      expect(sqlConversation?.execution).not.toHaveProperty("pendingCount");
      expect(sqlConversation?.execution).not.toHaveProperty("pendingMessages");
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("copies a bounded SQL conversation backfill slice", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      for (let index = 0; index < 3; index++) {
        const conversationId = `slack:C123:page-${index}`;
        await appendInboundMessage({
          message: inboundMessage(`page-${index}`, { conversationId }),
          nowMs: 1_000 + index,
          conversationStore: stateOnlyConversationStore,
          state: stateAdapter,
        });
      }

      await expect(
        migrateConversationsToSql(
          {
            io: { info: () => {} },
            stateAdapter,
          },
          { batchSize: 2, target: sqlStore },
        ),
      ).resolves.toEqual({
        existing: 0,
        migrated: 2,
        missing: 0,
        scanned: 2,
      });
      await expect(sqlStore.listByActivity({ limit: 10 })).resolves.toEqual([
        expect.objectContaining({ conversationId: "slack:C123:page-2" }),
        expect.objectContaining({ conversationId: "slack:C123:page-1" }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("backfills retained conversation metrics without replacing SQL totals", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const seedMs = Date.now() - 1_000;
      await sqlStore.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: seedMs,
        destination: SLACK_DESTINATION,
        execution: {
          runId: "run-two",
          status: "idle",
          updatedAtMs: seedMs,
        },
        lastActivityAtMs: seedMs,
        metrics: null,
        updatedAtMs: seedMs,
      });
      await recordAgentTurnSessionSummary({
        conversationId: CONVERSATION_ID,
        cumulativeDurationMs: 1_000,
        cumulativeUsage: {
          inputTokens: 40,
          outputTokens: 10,
          reasoningTokens: 3,
          cost: { total: 0.001 },
        },
        destination: SLACK_DESTINATION,
        conversationStore: stateOnlyConversationStore,
        sessionId: "run-one",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      });
      await recordAgentTurnSessionSummary({
        conversationId: CONVERSATION_ID,
        cumulativeDurationMs: 2_000,
        cumulativeUsage: {
          inputTokens: 80,
          outputTokens: 20,
          reasoningTokens: 7,
          cost: { total: 0.002 },
        },
        destination: SLACK_DESTINATION,
        conversationStore: stateOnlyConversationStore,
        sessionId: "run-two",
        sliceId: 1,
        state: "completed",
        surface: "slack",
      });

      await migrateConversationsToSql(
        { io: { info: () => {} }, stateAdapter },
        { target: sqlStore },
      );

      const readMetrics = async () => {
        const [row] = await fixture.sql.query<{
          durationMs: number;
          executionDurationMs: number;
          executionUsage: {
            inputTokens?: number;
            outputTokens?: number;
          } | null;
          usage: {
            cost?: { total?: number };
            inputTokens?: number;
            outputTokens?: number;
            reasoningTokens?: number;
            totalTokens?: number;
          } | null;
        }>(
          `
SELECT
  duration_ms AS "durationMs",
  usage_json AS usage,
  execution_duration_ms AS "executionDurationMs",
  execution_usage_json AS "executionUsage"
FROM junior_conversations
WHERE conversation_id = $1
`,
          [CONVERSATION_ID],
        );
        return row;
      };
      await expect(readMetrics()).resolves.toMatchObject({
        durationMs: 3_000,
        executionDurationMs: 2_000,
        executionUsage: {
          inputTokens: 80,
          outputTokens: 20,
        },
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          reasoningTokens: 10,
          cost: { total: 0.003 },
        },
      });

      const futureMs = Date.now() + 60_000;
      await sqlStore.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: futureMs,
        execution: {
          runId: "run-three",
          status: "idle",
          updatedAtMs: futureMs,
        },
        lastActivityAtMs: futureMs,
        metrics: {
          durationMs: 500,
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            reasoningTokens: 1,
            cost: { total: 0.0005 },
          },
        },
        updatedAtMs: futureMs,
      });
      await migrateConversationsToSql(
        { io: { info: () => {} }, stateAdapter },
        { target: sqlStore },
      );

      await expect(readMetrics()).resolves.toMatchObject({
        durationMs: 3_500,
        executionDurationMs: 500,
        usage: {
          reasoningTokens: 11,
          totalTokens: 160,
          cost: { total: 0.0035 },
        },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("repairs SQL usage in bounded batches without changing duration", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const mixedConversationId = `${CONVERSATION_ID}:mixed`;
    const unsafeConversationId = `${CONVERSATION_ID}:unsafe`;
    const firstAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "first" }],
      api: "responses",
      provider: "openai",
      model: "test-model",
      stopReason: "stop",
      timestamp: 2_000,
      usage: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        reasoning: 1,
        totalTokens: 16,
        cost: {
          input: 0.001,
          output: 0.002,
          cacheRead: 0.0003,
          cacheWrite: 0.0004,
          total: 0.0037,
        },
      },
    } as PiMessage;
    const secondAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
      api: "responses",
      provider: "openai",
      model: "test-model",
      stopReason: "stop",
      timestamp: 3_000,
      usage: {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 2,
        totalTokens: 25,
        cost: {
          input: 0.004,
          output: 0.006,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.01,
        },
      },
    } as PiMessage;

    try {
      await migrateSchema(fixture.sql);
      await sqlStore.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "run-two",
          status: "idle",
          updatedAtMs: 4_000,
        },
        lastActivityAtMs: 4_000,
        metrics: {
          durationMs: 9_000,
          usage: { totalTokens: 999, cost: { total: 0.999 } },
        },
        updatedAtMs: 4_000,
      });
      await stepStore.startEpoch(CONVERSATION_ID, {
        reason: "initial",
        modelProfile: "standard",
        modelId: "test-model",
        messages: [{ message: firstAssistant, createdAtMs: 2_000 }],
      });
      await stepStore.startEpoch(CONVERSATION_ID, {
        reason: "compaction",
        modelProfile: "standard",
        modelId: "test-model",
        messages: [{ message: firstAssistant, createdAtMs: 2_000 }],
      });
      await stepStore.append(CONVERSATION_ID, [
        {
          entry: { type: "pi_message", message: secondAssistant },
          createdAtMs: 3_000,
        },
      ]);
      await sqlStore.recordExecution({
        conversationId: mixedConversationId,
        createdAtMs: 1_000,
        execution: { status: "idle", updatedAtMs: 4_000 },
        lastActivityAtMs: 4_000,
        metrics: { durationMs: 1_000, usage: { totalTokens: 777 } },
        updatedAtMs: 4_000,
      });
      await stepStore.append(mixedConversationId, [
        {
          entry: {
            type: "pi_message",
            message: {
              role: "assistant",
              usage: { input: 3, totalTokens: 999 },
            } as PiMessage,
          },
          createdAtMs: 2_000,
        },
        {
          entry: {
            type: "pi_message",
            message: {
              role: "assistant",
              usage: { totalTokens: 5 },
            } as PiMessage,
          },
          createdAtMs: 3_000,
        },
      ]);
      await sqlStore.recordExecution({
        conversationId: unsafeConversationId,
        createdAtMs: 1_000,
        execution: { status: "idle", updatedAtMs: 4_000 },
        lastActivityAtMs: 4_000,
        metrics: { durationMs: 1_000, usage: { totalTokens: 777 } },
        updatedAtMs: 4_000,
      });
      await stepStore.append(unsafeConversationId, [
        {
          entry: {
            type: "pi_message",
            message: {
              role: "assistant",
              usage: { input: 9_007_199_254_740_992 },
            } as PiMessage,
          },
          createdAtMs: 3_000,
        },
      ]);
      const context = { io: { info: vi.fn() }, stateAdapter };
      await expect(
        repairConversationUsage(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 2,
        missing: 1,
        scanned: 3,
      });
      const [metrics] = await fixture.sql.query<{
        durationMs: number;
        executionDurationMs: number;
        usage: Record<string, unknown>;
      }>(
        `
SELECT
  duration_ms AS "durationMs",
  execution_duration_ms AS "executionDurationMs",
  usage_json AS usage
FROM junior_conversations
WHERE conversation_id = $1
`,
        [CONVERSATION_ID],
      );
      expect(metrics).toEqual({
        durationMs: 9_000,
        executionDurationMs: 9_000,
        usage: {
          inputTokens: 30,
          outputTokens: 7,
          cachedInputTokens: 3,
          cacheCreationTokens: 1,
          reasoningTokens: 3,
          cost: {
            input: 0.005,
            output: 0.008,
            cacheRead: 0.0003,
            cacheWrite: 0.0004,
            total: 0.0137,
          },
        },
      });
      const [mixed] = await fixture.sql.query<{ usage: unknown }>(
        `SELECT usage_json AS usage FROM junior_conversations WHERE conversation_id = $1`,
        [mixedConversationId],
      );
      expect(mixed?.usage).toEqual({ totalTokens: 8 });
      const [unsafe] = await fixture.sql.query<{ usage: unknown }>(
        `SELECT usage_json AS usage FROM junior_conversations WHERE conversation_id = $1`,
        [unsafeConversationId],
      );
      expect(unsafe?.usage).toEqual({ totalTokens: 777 });

      await expect(
        repairConversationUsage(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 2,
        migrated: 0,
        missing: 1,
        scanned: 3,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("commits completed usage batches before a later batch fails", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);
    const conversationIds = ["local:usage-batch-a", "local:usage-batch-b"];

    try {
      await migrateSchema(fixture.sql);
      for (const [index, conversationId] of conversationIds.entries()) {
        await sqlStore.recordExecution({
          conversationId,
          createdAtMs: 1_000,
          execution: { status: "idle", updatedAtMs: 2_000 },
          lastActivityAtMs: 2_000,
          metrics: { durationMs: 1_000, usage: { totalTokens: 999 } },
          updatedAtMs: 2_000,
        });
        await stepStore.append(conversationId, [
          {
            entry: {
              type: "pi_message",
              message: {
                role: "assistant",
                usage: { input: index + 1, totalTokens: index + 1 },
              } as PiMessage,
            },
            createdAtMs: 2_000,
          },
        ]);
      }

      let queryCount = 0;
      const failingExecutor = new Proxy(fixture.sql, {
        get(target, key, receiver) {
          if (key === "query") {
            return async (
              statement: string,
              params: readonly unknown[] = [],
            ) => {
              queryCount += 1;
              if (queryCount === 2) {
                throw new Error("later usage batch failed");
              }
              return target.query(statement, params);
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const context = { io: { info: vi.fn() }, stateAdapter };
      await expect(
        repairConversationUsage(context, {
          batchSize: 1,
          executor: failingExecutor,
        }),
      ).rejects.toThrow("later usage batch failed");

      const beforeRetry = await fixture.sql.query<{
        conversationId: string;
        usage: unknown;
      }>(
        `SELECT conversation_id AS "conversationId", usage_json AS usage
         FROM junior_conversations ORDER BY conversation_id`,
      );
      expect(beforeRetry).toEqual([
        {
          conversationId: conversationIds[0],
          usage: { inputTokens: 1 },
        },
        { conversationId: conversationIds[1], usage: { totalTokens: 999 } },
      ]);
      await expect(
        repairConversationUsage(context, {
          batchSize: 1,
          executor: fixture.sql,
        }),
      ).resolves.toEqual({
        existing: 1,
        migrated: 1,
        missing: 0,
        scanned: 2,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("reports version-guard misses as skipped", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();

    try {
      let queryCount = 0;
      const skippedExecutor = new Proxy(fixture.sql, {
        get(target, key, receiver) {
          if (key === "query") {
            return async () => {
              queryCount += 1;
              return queryCount === 1
                ? [
                    {
                      changed: false,
                      conversationId: CONVERSATION_ID,
                      matched: false,
                      repairable: true,
                    },
                  ]
                : [];
            };
          }
          const value = Reflect.get(target, key, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(
        repairConversationUsage(
          { io: { info: vi.fn() }, stateAdapter },
          { executor: skippedExecutor },
        ),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 1,
        skipped: 1,
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("repairs a conversation on rerun after it becomes idle", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);
    const stepStore = createSqlAgentStepStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      await sqlStore.recordExecution({
        conversationId: CONVERSATION_ID,
        createdAtMs: 1_000,
        execution: {
          runId: "active-run",
          status: "running",
          updatedAtMs: 2_000,
        },
        lastActivityAtMs: 2_000,
        metrics: {
          durationMs: 7_777,
          usage: { totalTokens: 999, cost: { total: 0.999 } },
        },
        updatedAtMs: 2_000,
      });
      await stepStore.append(CONVERSATION_ID, [
        {
          entry: {
            type: "pi_message",
            message: {
              role: "assistant",
              usage: { input: 4, output: 2, totalTokens: 6 },
            } as PiMessage,
          },
          createdAtMs: 2_000,
        },
      ]);
      const context = { io: { info: vi.fn() }, stateAdapter };
      await expect(
        repairConversationUsage(context, { executor: fixture.sql }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 0,
        missing: 0,
        scanned: 0,
      });

      await fixture.sql.execute(
        `UPDATE junior_conversations SET execution_status = 'idle' WHERE conversation_id = $1`,
        [CONVERSATION_ID],
      );
      await expect(
        repairConversationUsage(context, { executor: fixture.sql }),
      ).resolves.toEqual({
        existing: 0,
        migrated: 1,
        missing: 0,
        scanned: 1,
      });
      const [metrics] = await fixture.sql.query<{
        durationMs: number;
        usage: Record<string, unknown>;
      }>(
        `SELECT duration_ms AS "durationMs", usage_json AS usage
         FROM junior_conversations WHERE conversation_id = $1`,
        [CONVERSATION_ID],
      );
      expect(metrics).toEqual({
        durationMs: 7_777,
        usage: { inputTokens: 4, outputTokens: 2 },
      });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("seeds active awaiting continuations into conversation work", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await recordAgentTurnSessionSummary({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      sessionId: "turn-timeout",
      sliceId: 2,
      state: "awaiting_resume",
      conversationStore: stateOnlyConversationStore,
    });
    await persistActiveTurn(CONVERSATION_ID, "turn-timeout");

    await expect(
      redisConversationStateMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 0,
      migrated: 1,
      missing: 0,
      scanned: 1,
    });
    await expect(
      stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      execution: {
        pendingCount: 0,
        pendingMessages: [],
        status: "pending",
      },
    });
    await expect(
      stateAdapter.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: expect.any(Number),
      },
    ]);
  });

  it("merges legacy pending work when the conversation record already exists", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      conversationStore: stateOnlyConversationStore,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    await stateAdapter.delete(CONVERSATION_BY_ACTIVITY_INDEX_KEY);
    await stateAdapter.delete(CONVERSATION_ACTIVE_INDEX_KEY);
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        messages: [inboundMessage("m1")],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    await expect(
      redisConversationStateMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 1,
      migrated: 0,
      missing: 0,
      scanned: 1,
    });
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get(`junior:conversation:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      lastActivityAtMs: 2_000,
      updatedAtMs: 3_000,
      execution: {
        inboundMessageIds: ["m1"],
        pendingCount: 1,
        pendingMessages: [expect.objectContaining({ inboundMessageId: "m1" })],
        status: "pending",
        updatedAtMs: 3_000,
      },
    });
    await expect(
      stateAdapter.get("junior:conversation-work:index"),
    ).resolves.toBeNull();
    await expect(
      stateAdapter.get(CONVERSATION_BY_ACTIVITY_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 2_000,
      },
    ]);
    await expect(
      stateAdapter.get(CONVERSATION_ACTIVE_INDEX_KEY),
    ).resolves.toEqual([
      {
        conversationId: CONVERSATION_ID,
        score: 3_000,
      },
    ]);
  });

  it("does not merge legacy pending work with a different destination", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      conversationStore: stateOnlyConversationStore,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: OTHER_SLACK_DESTINATION,
        messages: [
          {
            ...inboundMessage("m1"),
            destination: OTHER_SLACK_DESTINATION,
          },
        ],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    await expect(
      redisConversationStateMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).rejects.toThrow(
      `Legacy conversation work destination does not match conversation ${CONVERSATION_ID}`,
    );
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toEqual(expect.objectContaining({ needsRun: true }));
  });

  it("rejects legacy pending work with a different message destination", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set(
      `junior:conversation-work:state:${CONVERSATION_ID}`,
      {
        schemaVersion: 1,
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        messages: [
          {
            ...inboundMessage("m1"),
            destination: OTHER_SLACK_DESTINATION,
          },
        ],
        needsRun: true,
        updatedAtMs: 3_000,
      },
    );
    await stateAdapter.set("junior:conversation-work:index", [CONVERSATION_ID]);

    await expect(
      redisConversationStateMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).rejects.toThrow(
      `Legacy conversation work state is invalid for ${CONVERSATION_ID}`,
    );
    await expect(
      stateAdapter.get(`junior:conversation-work:state:${CONVERSATION_ID}`),
    ).resolves.toEqual(expect.objectContaining({ needsRun: true }));
  });

  it("ignores malformed legacy conversation work indexes", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await stateAdapter.set("junior:conversation-work:index", {
      conversationId: CONVERSATION_ID,
    });

    await expect(
      redisConversationStateMigration.run({
        io: { info: () => {} },
        stateAdapter,
      }),
    ).resolves.toEqual({
      existing: 0,
      migrated: 0,
      missing: 0,
      scanned: 0,
    });
  });

  it("backfills retained conversation record into SQL when configured", async () => {
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      conversationStore: stateOnlyConversationStore,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state: stateAdapter,
    });
    const fixture = await createLocalJuniorSqlFixture();
    const sqlStore = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const context = {
        io: { info: () => {} },
        stateAdapter,
      };
      const results = [
        await redisConversationStateMigration.run(context),
        await migrateConversationsToSql(context, { target: sqlStore }),
      ];

      expect(results).toEqual([
        {
          existing: 0,
          migrated: 0,
          missing: 0,
          scanned: 0,
        },
        {
          existing: 0,
          migrated: 1,
          missing: 0,
          scanned: 1,
        },
      ]);
      const sqlConversation = await sqlStore.get({
        conversationId: CONVERSATION_ID,
      });
      expect(sqlConversation).toMatchObject({
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        execution: {
          status: "pending",
        },
      });
      expect(sqlConversation?.execution).not.toHaveProperty("pendingCount");
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
