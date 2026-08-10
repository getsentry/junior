import { describe, expect, test, vi } from "vitest";
import { testViewer } from "../../../fixtures/user";
import { eq } from "drizzle-orm";
import { createJuniorApi } from "@/api";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { readPeopleProfileFromSql } from "@/api/people/profile.query";
import { readConversationDetail } from "@/api/conversations/detail";
import { actorProfileReportSchema, apiErrorSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations, juniorIdentities } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../../fixtures/sql";
import { seedDisplayNameBackfill, seedPeople } from "./fixture";

describe("people profile API", () => {
  test("validates and decodes profile identifiers", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const app = createJuniorApi();

      const invalid = await app.request("http://localhost/api/people/%20");
      expect(invalid.status).toBe(400);
      expect(apiErrorSchema.parse(await invalid.json())).toEqual({
        error: "Invalid route parameters.",
      });

      const encoded = await app.request(
        "http://localhost/api/people/person%25tag%40example.com",
      );
      expect(encoded.status).toBe(200);
      expect(
        actorProfileReportSchema.parse(await encoded.json()),
      ).toMatchObject({
        actor: { email: "person%tag@example.com" },
      });
    } finally {
      await fixture.close();
    }
  });

  test("derives child participation and visibility from its root", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    const rootConversationId = "slack:G-private:root";
    const childConversationId = "slack:C-public:child";
    const ownerChildConversationId = "slack:C-public:owner-child";

    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: rootConversationId,
        actor: {
          email: "owner@example.com",
          platform: "slack",
          slackUserId: "U-owner",
          teamId: "T1",
        },
        destination: {
          channelId: "GPRIVATE",
          platform: "slack",
          teamId: "T1",
        },
        title: "Private root title",
        visibility: "private",
      });
      await store.recordActivity({
        conversationId: childConversationId,
        actor: {
          email: "child@example.com",
          platform: "slack",
          slackUserId: "U-child",
          teamId: "T1",
        },
        destination: {
          channelId: "CPUBLIC",
          platform: "slack",
          teamId: "T1",
        },
        title: "Child participant title",
        visibility: "public",
      });
      await store.recordActivity({
        conversationId: ownerChildConversationId,
        actor: {
          email: "owner@example.com",
          platform: "slack",
          slackUserId: "U-owner",
          teamId: "T1",
        },
        destination: {
          channelId: "CPUBLIC",
          platform: "slack",
          teamId: "T1",
        },
        title: "Owner child title",
        visibility: "public",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          parentConversationId: rootConversationId,
          rootConversationId,
        })
        .where(eq(juniorConversations.conversationId, childConversationId));
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          parentConversationId: rootConversationId,
          rootConversationId,
        })
        .where(
          eq(juniorConversations.conversationId, ownerChildConversationId),
        );
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ durationMs: 300, usage: { totalTokens: 3 } })
        .where(eq(juniorConversations.conversationId, rootConversationId));
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ durationMs: 700, usage: { totalTokens: 7 } })
        .where(eq(juniorConversations.conversationId, childConversationId));
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ durationMs: 500, usage: { totalTokens: 5 } })
        .where(
          eq(juniorConversations.conversationId, ownerChildConversationId),
        );

      const rootReport = await readPeopleProfileFromSql("owner@example.com", {
        viewer: testViewer("owner@example.com"),
      });
      expect(rootReport.recentConversations).toHaveLength(2);
      expect(rootReport.recentConversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: rootConversationId,
            cumulativeDurationMs: 1_500,
            cumulativeUsage: { totalTokens: 15 },
          }),
          expect.objectContaining({
            conversationId: ownerChildConversationId,
            cumulativeDurationMs: 500,
            cumulativeUsage: { totalTokens: 5 },
          }),
        ]),
      );
      expect(rootReport).toMatchObject({
        locations: expect.arrayContaining([
          expect.objectContaining({ durationMs: 1_500, tokens: 15 }),
        ]),
        surfaces: [
          expect.objectContaining({
            conversations: 2,
            durationMs: 1_500,
            tokens: 15,
          }),
        ],
        totals: {
          conversations: 2,
          durationMs: 1_500,
          tokens: 15,
        },
      });
      expect(rootReport.activityDays).toContainEqual(
        expect.objectContaining({
          conversations: 2,
          durationMs: 1_500,
          tokens: 15,
        }),
      );
      const directory = await readPeopleListFromSql();
      expect(
        directory.people.find(
          (person) => person.actor.email === "owner@example.com",
        ),
      ).toMatchObject({
        conversations: 2,
        durationMs: 1_500,
        tokens: 15,
      });

      const report = await readPeopleProfileFromSql("child@example.com", {
        viewer: testViewer("OWNER@example.com"),
      });

      expect(report.recentConversations).toEqual([
        expect.objectContaining({
          conversationId: childConversationId,
          displayTitle: "Child participant title",
          isParticipant: true,
        }),
      ]);
      expect(report.totals).toMatchObject({
        conversations: 1,
        durationMs: 700,
        tokens: 7,
      });
      expect(report.recentConversations[0]).not.toHaveProperty("locationId");
      const detail = await readConversationDetail(childConversationId, {
        viewer: testViewer("owner@example.com"),
      });
      expect(detail).toMatchObject(report.recentConversations[0] ?? {});

      const malformedConversationId = "slack:C-public:malformed-root";
      await store.recordActivity({
        conversationId: malformedConversationId,
        actor: {
          email: "malformed@example.com",
          platform: "slack",
          slackUserId: "U-malformed",
          teamId: "T1",
        },
        destination: {
          channelId: "CPUBLIC",
          platform: "slack",
          teamId: "T1",
        },
        title: "Malformed title must stay private",
        visibility: "public",
      });
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({ rootConversationId })
        .where(eq(juniorConversations.conversationId, malformedConversationId));

      const malformed = await readPeopleProfileFromSql(
        "malformed@example.com",
        { viewer: testViewer("owner@example.com") },
      );
      expect(malformed.recentConversations).toEqual([
        expect.objectContaining({
          conversationId: malformedConversationId,
          displayTitle: "Private Conversation",
          isParticipant: false,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("reads profiles case-insensitively from shared verified identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await seedPeople(fixture);

      const report = await readPeopleProfileFromSql("ALICE@example.com");

      expect(report).toMatchObject({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
        totals: {
          active: 1,
          activeDays: 2,
          conversations: 2,
          durationMs: 1_500,
          failed: 1,
          tokens: 150,
        },
        locations: [
          expect.objectContaining({
            conversations: 1,
            durationMs: 1_000,
            label: "#proj-alpha",
            tokens: 100,
          }),
          expect.objectContaining({
            conversations: 1,
            durationMs: 500,
            failed: 1,
            label: "Private Conversation",
            tokens: 50,
          }),
        ],
      });
      expect(report.activityDays).toHaveLength(365);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-12"),
      ).toMatchObject({
        conversations: 1,
        costUsd: 0.17,
        durationMs: 500,
        failed: 1,
        tokens: 50,
      });
      expect(
        report.recentConversations.map((item) => item.conversationId),
      ).toEqual(["slack:C4:456", "slack:C1:123"]);
      expect(report.recentConversations.map((item) => item.status)).toEqual([
        "failed",
        "active",
      ]);
      expect(report.recentConversations[0]).toMatchObject({
        channelName: "Private Conversation",
        channelNameRedacted: true,
        displayTitle: "Private Conversation",
      });
      expect(report.recentConversations[1]).toMatchObject({
        conversationId: "slack:C1:123",
        locationId: expect.any(String),
      });

      const untrusted = await readPeopleProfileFromSql("untrusted@example.com");
      expect(untrusted).toMatchObject({
        actor: {
          email: "untrusted@example.com",
        },
        totals: {
          conversations: 0,
        },
      });

      const blank = await readPeopleProfileFromSql("  ");
      expect(blank).toMatchObject({
        actor: {
          email: "",
        },
        totals: {
          conversations: 0,
        },
      });

      await seedDisplayNameBackfill(fixture);
      const backfilled = await readPeopleProfileFromSql("nameless@example.com");
      expect(backfilled).toMatchObject({
        actor: {
          email: "nameless@example.com",
          fullName: "Named Later",
        },
        totals: {
          conversations: 2,
        },
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("aggregates every actor conversation and bounds only recent rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const nowMs = Date.parse("2026-06-15T11:00:00.000Z");
      await store.recordActivity({
        conversationId: "slack:C1:seed",
        actor: {
          email: "aggregate@example.com",
          fullName: "Aggregate Example",
          platform: "slack",
          slackUserId: "U-aggregate",
          teamId: "T1",
        },
        source: "slack",
        nowMs,
      });
      const [identity] = await fixture.sql.db().select().from(juniorIdentities);
      expect(identity).toBeDefined();

      const now = new Date(nowMs);
      const conversations = Array.from({ length: 5_000 }, (_, index) =>
        buildJuniorSqlConversation({
          actorIdentityId: identity?.id,
          conversationId: `slack:C1:aggregate:${index}`,
          destination: null,
          destinationId: null,
          durationMs: 2,
          createdAt: now,
          lastActivityAt: now,
          updatedAt: now,
          usage: { totalTokens: 3 },
        }),
      );
      for (let offset = 0; offset < conversations.length; offset += 500) {
        await fixture.sql
          .db()
          .insert(juniorConversations)
          .values(conversations.slice(offset, offset + 500));
      }

      const report = await readPeopleProfileFromSql("aggregate@example.com");
      expect(report.totals).toMatchObject({
        conversations: 5_001,
        durationMs: 10_000,
        tokens: 15_000,
      });
      expect(report.recentConversations).toHaveLength(25);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-15"),
      ).toMatchObject({
        conversations: 5_001,
        durationMs: 10_000,
        tokens: 15_000,
      });
      const directory = await readPeopleListFromSql();
      expect(directory.people).toEqual([
        expect.objectContaining({
          conversations: 5_001,
          durationMs: 10_000,
          tokens: 15_000,
          actor: expect.objectContaining({
            email: "aggregate@example.com",
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
