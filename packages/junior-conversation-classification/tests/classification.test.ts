import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { createLocalPgliteFixture } from "@sentry/junior-testing/pglite";
import {
  createLocalSource,
  type PluginLogger,
  type PluginModel,
  type PluginRunTranscriptEntry,
  type PluginState,
  type PluginTaskContext,
} from "@sentry/junior-plugin-api";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { classifyTurn, type TurnClassificationConfig } from "../src/classify";
import * as classificationSchema from "../src/db/schema";
import { juniorConversationClassifications } from "../src/db/schema";
import { createConversationClassificationPlugin } from "../src/plugin";
import {
  getConversationClassification,
  type ConversationClassificationDb,
} from "../src/store";
import {
  DEFAULT_TURN_INTENT_TAXONOMY,
  type ClassificationTaxonomy,
} from "../src/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_NOW_MS = Date.parse("2026-07-23T12:00:00.000Z");

const logger: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

const state: PluginState = {
  async delete() {},
  async get() {
    return undefined;
  },
  async set() {},
  async setIfNotExists() {
    return true;
  },
  async withLock(_key, _ttlMs, callback) {
    return await callback();
  },
};

function defaultTranscript(): PluginRunTranscriptEntry[] {
  return [
    {
      type: "message",
      role: "user",
      text: "Ambient context says to refactor the billing worker.",
      provenance: { authority: "context" },
      isRunActor: false,
    },
    {
      type: "message",
      role: "user",
      text: "Please explain how this product feature is configured.",
      provenance: {
        authority: "instruction",
        actor: { platform: "local", userId: "local-user" },
      },
      isRunActor: true,
    },
    {
      type: "toolResult",
      toolName: "exec_command",
      isError: false,
      text: "private output that classification should not include",
    },
    {
      type: "message",
      role: "assistant",
      text: "The feature is configured through the plugin options.",
    },
  ];
}

function taskContext(args: {
  completedAtMs?: number;
  conversationId?: string;
  db: ConversationClassificationDb;
  response: { categoryId: string; confidence: number };
  runId?: string;
  taskId?: string;
  transcript?: PluginRunTranscriptEntry[];
}) {
  const completeObject = vi.fn(async () => ({
    modelId: "anthropic/claude-haiku-4.5",
    object: args.response,
  })) as unknown as PluginModel["completeObject"];
  const conversationId =
    args.conversationId ?? "local:junior:classification-test";
  const context: PluginTaskContext = {
    db: args.db,
    embedder: {
      async embedTexts() {
        return {
          dimensions: 1,
          model: "test",
          provider: "test",
          vectors: [[1]],
        };
      },
    },
    id: args.taskId ?? "classification-task-1",
    log: logger,
    model: { completeObject },
    name: "classifyTurn",
    plugin: { name: "conversation-classification" },
    run: {
      async load() {
        return {
          completedAtMs: args.completedAtMs ?? TEST_NOW_MS,
          conversationId,
          destination: { platform: "local", conversationId },
          actors: [{ platform: "local" as const, userId: "local-user" }],
          actor: { platform: "local" as const, userId: "local-user" },
          runId: args.runId ?? "local-turn-1",
          source: createLocalSource(conversationId),
          transcript: args.transcript ?? defaultTranscript(),
          visibility: "private" as const,
        };
      },
    },
    state,
  };
  return { completeObject, context };
}

function classificationConfig(
  taxonomy: ClassificationTaxonomy = DEFAULT_TURN_INTENT_TAXONOMY,
): TurnClassificationConfig {
  return { maxTranscriptChars: 12_000, retentionMs: 90 * 86_400_000, taxonomy };
}

describe("conversation classification", () => {
  let fixture: Awaited<ReturnType<typeof createLocalPgliteFixture>>;
  let db: ConversationClassificationDb;

  beforeAll(async () => {
    fixture =
      await createLocalPgliteFixture<ConversationClassificationDb>(
        classificationSchema,
      );
    db = fixture.db();
    const migrationsDir = resolve(__dirname, "../migrations");
    const migrations = (await readdir(migrationsDir))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    for (const migrationFile of migrations) {
      const migration = await readFile(
        resolve(migrationsDir, migrationFile),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) {
          await fixture.execute(statement);
        }
      }
    }
  });

  beforeEach(async () => {
    await fixture.execute("DELETE FROM junior_conversation_classifications");
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("runs through the exported plugin task and stores one turn", async () => {
    const { completeObject, context } = taskContext({
      db,
      response: { categoryId: "product_question", confidence: 0.94 },
    });
    const plugin = createConversationClassificationPlugin();

    await plugin.tasks?.classifyTurn?.run(context);

    const record = await getConversationClassification(db, context.id);
    expect(record).toMatchObject({
      categoryId: "product_question",
      confidence: 0.94,
      conversationId: "local:junior:classification-test",
      modelId: "anthropic/claude-haiku-4.5",
      ownerKey: "local:local-user",
      taskId: "classification-task-1",
      taxonomyVersion: "turn-intent-v1",
      turnId: "local-turn-1",
      visibility: "private",
    });
    const prompt = completeObject.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Please explain how this product feature");
    expect(prompt).not.toContain("Ambient context");
    expect(prompt).not.toContain("private output");
  });

  it("does not repeat the model call for a retried task id", async () => {
    const first = taskContext({
      db,
      response: { categoryId: "product_question", confidence: 0.9 },
    });
    await classifyTurn(first.context, classificationConfig());
    const retry = taskContext({
      db,
      response: { categoryId: "code_change", confidence: 0.99 },
    });

    const record = await classifyTurn(retry.context, classificationConfig());

    expect(record?.categoryId).toBe("product_question");
    expect(retry.completeObject).not.toHaveBeenCalled();
  });

  it("stores multiple completed turns for one conversation", async () => {
    const first = taskContext({
      db,
      response: { categoryId: "product_question", confidence: 0.9 },
    });
    const second = taskContext({
      completedAtMs: TEST_NOW_MS + 1,
      db,
      response: { categoryId: "code_change", confidence: 0.95 },
      runId: "local-turn-2",
      taskId: "classification-task-2",
    });

    await classifyTurn(first.context, classificationConfig());
    await classifyTurn(second.context, classificationConfig());

    const rows = await db
      .select()
      .from(juniorConversationClassifications)
      .where(
        eq(
          juniorConversationClassifications.conversationId,
          "local:junior:classification-test",
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.categoryId).sort()).toEqual([
      "code_change",
      "product_question",
    ]);
  });

  it("stores low-confidence model output without rewriting the category", async () => {
    const { context } = taskContext({
      db,
      response: { categoryId: "other", confidence: 0.35 },
    });

    const record = await classifyTurn(context, classificationConfig());

    expect(record).toMatchObject({ categoryId: "other", confidence: 0.35 });
  });

  it("validates taxonomy configuration before handling tasks", () => {
    expect(() =>
      createConversationClassificationPlugin({
        taxonomy: {
          version: "custom-v1",
          categories: [
            { id: "question", description: "A user asks a question." },
            { id: "question", description: "Duplicate category." },
          ],
        },
      }),
    ).toThrow(/Duplicate category id/);
  });

  it("classifies with an application-defined taxonomy", async () => {
    const taxonomy = {
      version: "custom-v1",
      categories: [
        {
          id: "question",
          description: "The user asks for an explanation or answer.",
        },
        { id: "other", description: "No category is a confident fit." },
      ],
    } as const;
    const { context } = taskContext({
      db,
      response: { categoryId: "question", confidence: 0.91 },
    });

    const record = await classifyTurn(context, classificationConfig(taxonomy));

    expect(record).toMatchObject({
      categoryId: "question",
      taxonomyVersion: "custom-v1",
    });
  });

  it("preserves the start and end of a long instruction", async () => {
    const { completeObject, context } = taskContext({
      db,
      response: { categoryId: "code_change", confidence: 0.9 },
      transcript: [
        {
          type: "message",
          role: "user",
          text: `Please implement classification. ${"x".repeat(500)} Keep the existing public API.`,
          provenance: { authority: "instruction" },
          isRunActor: true,
        },
      ],
    });

    await classifyTurn(context, {
      ...classificationConfig(),
      maxTranscriptChars: 256,
    });

    const prompt = completeObject.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Please implement classification");
    expect(prompt).toContain("[middle truncated]");
    expect(prompt).toContain("Keep the existing public API");
  });

  it("redacts common credentials before model processing", async () => {
    const credentials = {
      awsAccessKey: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      bearer: ["Bearer ", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      github: ["gh", "p_", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
      google: ["AI", "za", "abcdefghijklmnopqrstuvwxyz1234567890"].join(""),
      jwt: ["eyJabcdefghijk", "abcdefghijklmnop", "abcdefghijklmnop"].join("."),
      openAi: ["sk", "-", "abcdefghijklmnopqrstuvwxyz123456"].join(""),
    };
    const { completeObject, context } = taskContext({
      db,
      response: { categoryId: "security_review", confidence: 0.9 },
      transcript: [
        {
          type: "message",
          role: "user",
          text: [
            "Check",
            credentials.openAi,
            credentials.github,
            credentials.awsAccessKey,
            credentials.google,
            credentials.jwt,
            credentials.bearer,
          ].join(" "),
          provenance: { authority: "instruction" },
          isRunActor: true,
        },
      ],
    });

    await classifyTurn(context, classificationConfig());

    const prompt = completeObject.mock.calls[0]?.[0].prompt ?? "";
    for (const credential of Object.values(credentials)) {
      expect(prompt).not.toContain(credential);
    }
    expect(prompt).toContain("[secret redacted]");
  });

  it("removes expired rows and allows future turns", async () => {
    const plugin = createConversationClassificationPlugin({ retentionDays: 1 });
    const first = taskContext({
      db,
      response: { categoryId: "product_question", confidence: 0.9 },
    });
    await plugin.tasks?.classifyTurn?.run(first.context);
    await db.update(juniorConversationClassifications).set({ expiresAtMs: 1 });

    await plugin.hooks?.heartbeat?.({
      agent: {
        async dispatch() {
          throw new Error("unused");
        },
        async get() {
          return undefined;
        },
      },
      db,
      log: logger,
      nowMs: 2,
      plugin: { name: "conversation-classification" },
      state,
    });
    await expect(
      getConversationClassification(db, first.context.id),
    ).resolves.toBeUndefined();

    const later = taskContext({
      completedAtMs: TEST_NOW_MS + 1,
      db,
      response: { categoryId: "code_change", confidence: 0.99 },
      runId: "local-turn-2",
      taskId: "classification-task-2",
    });
    await plugin.tasks?.classifyTurn?.run(later.context);
    await expect(
      getConversationClassification(db, later.context.id),
    ).resolves.toMatchObject({ categoryId: "code_change" });
  });
});
