import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { pluginOperationalReportFeedSchema } from "@/api/schema";
import { setBriefsConfig } from "@/chat/briefs/registration";
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
  afterEach(() => vi.useRealTimers());

  test("uses one UTC calendar window for Brief count and cost metrics", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-28T12:00:00.000Z") });
    const fixture = createConfiguredJuniorSqlFixture();
    const previousBriefsConfig = setBriefsConfig({ enabled: true });
    const windowStart = new Date("2026-06-29T00:00:00.000Z");
    const reports = [
      {
        conversationId: `local:brief-report:outside:${randomUUID()}`,
        costUsd: 0.5,
        createdAt: new Date(windowStart.getTime() - 1),
        turnId: "outside-turn",
      },
      {
        conversationId: `local:brief-report:inside:${randomUUID()}`,
        costUsd: 0.0042,
        createdAt: windowStart,
        turnId: "inside-turn",
      },
    ];
    try {
      await getDb()
        .insert(juniorConversations)
        .values(
          reports.map(({ conversationId, createdAt }) =>
            buildJuniorSqlConversation({
              conversationId,
              rootConversationId: conversationId,
              source: "local",
              destination: { platform: "local", conversationId },
              createdAt,
              lastActivityAt: createdAt,
              updatedAt: createdAt,
            }),
          ),
        );
      await getDb()
        .insert(juniorConversationBriefs)
        .values(
          reports.map(({ conversationId, costUsd, createdAt, turnId }) => ({
            conversationId,
            version: 1,
            turnId,
            throughSeq: 0,
            content: conversationBriefFixture(),
            searchText: "stored brief",
            modelId: "test-model",
            costUsd,
            createdAt,
          })),
        );
      await getDb()
        .insert(juniorConversationEvents)
        .values(
          reports.map(({ conversationId, costUsd, createdAt }) => ({
            conversationId,
            seq: 0,
            historyVersion: 1,
            type: "structured_event" as const,
            payload: {
              type: "structured_event" as const,
              namespace: "briefs",
              name: "brief_updated",
              version: 1,
              content: {
                version: 1,
                modelId: "test-model",
                costUsd,
                decisions: 1,
                openDecisions: 0,
                links: 1,
              },
            },
            createdAt,
          })),
        );

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
          { label: "briefs stored", tone: "good", value: "2" },
          { label: "conversations with a brief", value: "2" },
          { label: "briefs · 30d", value: "1" },
          { label: "cost · 30d · retained", value: "$0.0042" },
          {
            label: "average cost per brief · 30d · retained",
            value: "$0.0042",
          },
        ],
      });
      expect(
        report?.widgets?.[0]?.categories.find(
          (category) => category.id === "2026-06-29",
        ),
      ).toMatchObject({
        values: { briefs: 1, costUsd: 0.0042 },
      });
    } finally {
      setBriefsConfig(previousBriefsConfig);
      await fixture.close();
    }
  });
});
