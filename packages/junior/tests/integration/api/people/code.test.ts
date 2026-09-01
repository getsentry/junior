import { describe, expect, test, vi } from "vitest";
import type { CodeChangeInput } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { codePersonReportSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";

describe("people code API", () => {
  test("attributes code changes through conversation actors", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:alice",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-08-20T10:00:00.000Z"),
      });
      await store.recordActivity({
        conversationId: "slack:C1:bob",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        actor: {
          email: "bob@example.com",
          fullName: "Bob Example",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-08-21T10:00:00.000Z"),
      });

      const aliceChange = {
        conversationIds: ["slack:C1:alice"],
        mergedAt: new Date("2026-08-22T12:00:00.000Z"),
        number: 11,
        openedAt: new Date("2026-08-20T12:00:00.000Z"),
        providerId: "change-alice",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
          url: "https://github.com/getsentry/junior",
        },
        state: "merged",
        title: "Alice change",
        updatedAt: new Date("2026-08-22T12:00:00.000Z"),
        url: "https://github.com/getsentry/junior/pull/11",
      } satisfies CodeChangeInput;
      const bobChange = {
        conversationIds: ["slack:C1:bob"],
        number: 12,
        openedAt: new Date("2026-08-21T12:00:00.000Z"),
        providerId: "change-bob",
        repository: {
          name: "getsentry/junior",
          providerId: "repository-1",
          url: "https://github.com/getsentry/junior",
        },
        state: "open",
        title: "Bob change",
        updatedAt: new Date("2026-08-21T12:00:00.000Z"),
        url: "https://github.com/getsentry/junior/pull/12",
      } satisfies CodeChangeInput;
      await recordCodeChange(fixture.sql.db(), "github", aliceChange);
      await recordCodeChange(fixture.sql.db(), "github", bobChange);

      const response = await createJuniorApi().request(
        "http://localhost/api/people/alice@example.com/code",
      );
      expect(response.status).toBe(200);
      const report = codePersonReportSchema.parse(await response.json());
      expect(report.summary).toEqual({
        closed: 0,
        costUsd: 0,
        created: 1,
        medianMergeTimeMs: 2 * 24 * 60 * 60 * 1_000,
        merged: 1,
        mergeRate: 1,
        open: 0,
      });
      expect(report.activityDays).toHaveLength(90);
      expect(report.activityDays.at(-3)).toEqual({
        closed: 0,
        created: 0,
        date: "2026-08-22",
        merged: 1,
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
