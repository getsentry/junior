import { describe, expect, test, vi } from "vitest";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { createJuniorRuntimeServices } from "@/chat/app/services";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { commitMessages } from "@/chat/conversations/projection";
import type { PiMessage } from "@/chat/pi/messages";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { juniorConversationUsageEvents } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

describe("auxiliary model usage reporting", () => {
  test("includes compaction and classifier cost in the root conversation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const conversationId = "slack:C123:1752235200.000000";
    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      await store.recordActivity({
        conversationId,
        source: "slack",
        nowMs: Date.now(),
      });
      const piMessages = [
        {
          role: "user",
          content: [{ type: "text", text: `compact ${"x".repeat(10_000)}` }],
          timestamp: Date.now(),
        },
      ] as PiMessage[];
      await commitMessages({ conversationId, messages: piMessages });

      const services = createJuniorRuntimeServices({
        contextCompactor: {
          autoCompactionTriggerTokens: 0,
          completeText: async () =>
            ({
              text: "Compacted context.",
              usage: {
                totalTokens: 20,
                cost: { total: 0.02 },
              },
            }) as never,
        },
        subscribedReplyPolicy: {
          completeObject: (async () => ({
            object: {
              should_reply: true,
              should_unsubscribe: false,
              confidence: 0.95,
              reason: "direct question",
            },
            usage: {
              totalTokens: 30,
              cost: { total: 0.03 },
            },
          })) as never,
        },
      });

      await services.contextCompactor.maybeCompact({
        conversation: coerceThreadConversationState({}),
        conversationId,
        piMessages,
        metadata: { threadId: conversationId },
      });
      await services.subscribedReplyPolicy({
        rawText: "some new text",
        text: "some new text",
        context: { conversationId, threadId: conversationId },
      });

      const report = await readConversationStatsFromSql();
      const events = await fixture.sql
        .db()
        .select()
        .from(juniorConversationUsageEvents);
      expect(events).toHaveLength(2);
      expect(report).toMatchObject({
        conversations: 1,
        costUsd: 0.05,
        tokens: 50,
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
