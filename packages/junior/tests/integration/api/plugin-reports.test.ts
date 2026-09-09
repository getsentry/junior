import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { pluginOperationalReportFeedSchema } from "@/api/schema";
import { getDb } from "@/chat/db";
import {
  juniorConversationBriefs,
  juniorConversationEvents,
  juniorConversations,
} from "@/db/schema";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../fixtures/sql";

describe("plugin reports API route", () => {
  test("includes Brief storage and generation cost metrics", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const now = new Date();
    const conversationId = `local:brief-report:${randomUUID()}`;
    try {
      await getDb()
        .insert(juniorConversations)
        .values(
          buildJuniorSqlConversation({
            conversationId,
            rootConversationId: conversationId,
            source: "local",
            destination: { platform: "local", conversationId },
            createdAt: now,
            lastActivityAt: now,
            updatedAt: now,
          }),
        );
      await getDb().insert(juniorConversationBriefs).values({
        conversationId,
        version: 1,
        turnId: "brief-turn",
        throughSeq: 0,
        content: conversationBriefFixture(),
        searchText: "stored brief",
        modelId: "test-model",
        costUsd: 0.0042,
        createdAt: now,
      });
      await getDb()
        .insert(juniorConversationEvents)
        .values({
          conversationId,
          seq: 0,
          historyVersion: 1,
          type: "structured_event",
          payload: {
            type: "structured_event",
            namespace: "briefs",
            name: "brief_updated",
            version: 1,
            content: {
              version: 1,
              modelId: "test-model",
              costUsd: 0.0042,
              decisions: 1,
              openDecisions: 0,
              links: 1,
            },
          },
          createdAt: now,
        });

      const response = await createJuniorApi().request(
        "http://localhost/api/plugin-reports",
      );

      expect(response.status).toBe(200);
      const feed = pluginOperationalReportFeedSchema.parse(
        await response.json(),
      );
      const report = feed.reports.find(
        (candidate) => candidate.pluginName === "briefs",
      );
      expect(report).toMatchObject({
        title: "Briefs",
        metrics: [
          { label: "briefs stored", tone: "good", value: "1" },
          { label: "conversations with a brief", value: "1" },
          { label: "briefs · 30d", value: "1" },
          { label: "cost · 30d", value: "$0.0042" },
          { label: "average cost per brief · 30d", value: "$0.0042" },
        ],
      });
      expect(report?.widgets?.[0]?.categories.at(-1)).toMatchObject({
        values: { briefs: 1, costUsd: 0.0042 },
      });
    } finally {
      await fixture.close();
    }
  });
});
