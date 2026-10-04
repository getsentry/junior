import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { purgeConversationTree } from "@/chat/conversations/sql/purge";
import {
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";

describe("Conversation observation retention", () => {
  let fixture: LocalJuniorSqlFixture;

  beforeEach(async () => {
    fixture = await createJuniorSqlFixture();
    await migrateSchema(fixture.sql);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("purges stored observations and rejects a late worker or history replacement", async () => {
    const conversationId = "local:retention:distillation";
    const history = createSqlConversationEventStore(fixture.sql);
    await history.append(conversationId, [
      {
        data: {
          type: "message",
          messageId: "first",
          role: "user",
          text: "Earlier work.",
        },
        createdAtMs: 1,
      },
    ]);
    const observation = {
      type: "distillation" as const,
      generation: 0 as const,
      sourceHistoryVersion: 0,
      fromSeq: 0,
      throughSeq: 0,
      observations: "Earlier work as evidence only.",
      modelId: "openai/gpt-6-luna",
      costUsd: 0.001,
    };
    await history.append(
      conversationId,
      [{ data: observation, createdAtMs: 2 }],
      { activity: "preserve" },
    );

    await expect(
      purgeConversationTree(fixture.sql, {
        rootConversationId: conversationId,
        nowMs: 3,
      }),
    ).resolves.toMatchObject({ purged: true, conversations: 1 });
    await expect(history.loadHistory(conversationId)).resolves.toEqual([]);
    await expect(
      history.append(conversationId, [{ data: observation, createdAtMs: 4 }], {
        activity: "preserve",
      }),
    ).rejects.toThrow(/purged/);
    await expect(
      history.replaceHistory(conversationId, {
        data: {
          type: "compaction",
          modelProfile: "standard",
          modelId: "openai/gpt-6-luna",
          summary: "old observations",
          replacementHistory: [],
        },
        createdAtMs: 4,
      }),
    ).rejects.toThrow(/purged/);
    await expect(history.loadHistory(conversationId)).resolves.toEqual([]);
  });
});
