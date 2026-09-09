import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { searchConversationBriefs } from "@/chat/briefs/search";
import { appendConversationBrief } from "@/chat/briefs/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { juniorConversationBriefs, juniorConversations } from "@/db/schema";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
import { createLocalJuniorSqlFixture } from "../../fixtures/sql";

const tenantScope = {
  kind: "public_provider_tenant" as const,
  provider: "slack" as const,
  providerTenantId: "T123",
};

describe("Conversation Brief search", () => {
  it("searches only the latest public root Briefs in the authorized scope", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const conversations = createSqlStore(fixture.sql);
      const currentConversationId = "slack:CREQUEST:1700000000.100000";
      const targetConversationId = "slack:CARCHIVE:1700000000.200000";
      const otherTenantId = "slack:COTHER:1700000000.300000";
      const privateId = "slack:CPRIVATE:1700000000.400000";
      const childId = "slack:CARCHIVE:1700000000.500000";
      const publicLocalId = "local:test:public-brief-search";

      const recordSlack = async (args: {
        channelId: string;
        conversationId: string;
        teamId?: string;
        visibility: "private" | "public";
      }) => {
        await conversations.recordActivity({
          channelName: `${args.channelId.toLowerCase()}-name`,
          conversationId: args.conversationId,
          destination: {
            platform: "slack",
            teamId: args.teamId ?? "T123",
            channelId: args.channelId,
          },
          nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
          source: "slack",
          title: `Title for ${args.channelId}`,
          visibility: args.visibility,
        });
      };
      await recordSlack({
        channelId: "CREQUEST",
        conversationId: currentConversationId,
        visibility: "public",
      });
      await recordSlack({
        channelId: "CARCHIVE",
        conversationId: targetConversationId,
        visibility: "public",
      });
      await recordSlack({
        channelId: "COTHER",
        conversationId: otherTenantId,
        teamId: "TOTHER",
        visibility: "public",
      });
      await recordSlack({
        channelId: "CPRIVATE",
        conversationId: privateId,
        visibility: "private",
      });
      await conversations.createChild({
        childConversationId: childId,
        parentConversationId: targetConversationId,
        nowMs: Date.parse("2026-07-01T12:01:00.000Z"),
        source: "slack",
      });
      await recordSlack({
        channelId: "CARCHIVE",
        conversationId: childId,
        visibility: "public",
      });
      await conversations.recordActivity({
        conversationId: publicLocalId,
        destination: { platform: "local", conversationId: publicLocalId },
        nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
        source: "local",
        title: "Public web Brief",
        visibility: "public",
      });

      const append = async (args: {
        conversationId: string;
        searchText: string;
        status?: "blocked" | "done";
        summary: string;
        turnId: string;
      }) =>
        await appendConversationBrief(db, {
          conversationId: args.conversationId,
          turnId: args.turnId,
          throughSeq: 1,
          content: conversationBriefFixture({
            links: Array.from({ length: 6 }, (_, index) => ({
              kind: "url" as const,
              label: `Link ${index + 1}`,
              url: `https://example.com/${index + 1}`,
            })),
            status: args.status,
            summary: args.summary,
          }),
          searchText: args.searchText,
          modelId: "test-model",
        });

      await append({
        conversationId: currentConversationId,
        searchText: "current deployment decision",
        summary: "The current deployment decision stays excluded.",
        turnId: "current-turn",
      });
      await append({
        conversationId: targetConversationId,
        searchText: "obsolete migration choice",
        summary: "The obsolete migration choice was replaced.",
        turnId: "target-turn-1",
      });
      await append({
        conversationId: targetConversationId,
        searchText: "deployment decision uses the blue rollout",
        status: "done",
        summary: "The deployment decision uses the blue rollout.",
        turnId: "target-turn-2",
      });
      await append({
        conversationId: otherTenantId,
        searchText: "deployment decision from another workspace",
        summary: "Another workspace has a deployment decision.",
        turnId: "other-turn",
      });
      await append({
        conversationId: privateId,
        searchText: "private deployment decision",
        summary: "The private deployment decision stays private.",
        turnId: "private-turn",
      });
      await append({
        conversationId: childId,
        searchText: "child deployment decision",
        summary: "The child deployment decision stays excluded.",
        turnId: "child-turn",
      });
      await append({
        conversationId: publicLocalId,
        searchText: "browser launch decision",
        summary: "The browser launch decision is public.",
        turnId: "local-turn",
      });
      const updatedAt = new Date("2026-07-02T12:00:00.000Z");
      await db
        .update(juniorConversationBriefs)
        .set({ createdAt: updatedAt })
        .where(
          eq(juniorConversationBriefs.conversationId, targetConversationId),
        );
      await db
        .update(juniorConversations)
        .set({ transcriptPurgedAt: new Date("2026-07-03T12:00:00.000Z") })
        .where(eq(juniorConversations.conversationId, targetConversationId));
      await createPluginAnnotations({
        conversationId: targetConversationId,
        db,
        plugin: "code-host",
      }).upsert({
        kind: "resource_link",
        key: "acme/widget#12",
        label: "acme/widget#12",
        url: "https://example.com/acme/widget/12",
      });

      const matches = await searchConversationBriefs(db, {
        currentConversationId,
        filters: { query: "deployment decision" },
        limit: 10,
        scope: tenantScope,
      });
      expect(matches).toEqual([
        expect.objectContaining({
          channelName: "carchive-name",
          conversationId: targetConversationId,
          links: expect.arrayContaining([
            expect.objectContaining({ url: "https://example.com/1" }),
          ]),
          outcomeStatus: "done",
          providerDestinationId: "CARCHIVE",
          summary: "The deployment decision uses the blue rollout.",
          title: "Title for CARCHIVE",
          updatedAtMs: updatedAt.getTime(),
          version: 2,
        }),
      ]);
      expect(matches[0]?.links).toHaveLength(5);
      expect(matches[0]?.excerpt).toContain("**deployment**");

      await expect(
        searchConversationBriefs(db, {
          currentConversationId,
          filters: { query: "obsolete migration" },
          limit: 10,
          scope: tenantScope,
        }),
      ).resolves.toEqual([]);

      await expect(
        searchConversationBriefs(db, {
          currentConversationId,
          filters: {
            afterMs: Date.parse("2026-07-02T00:00:00.000Z"),
            annotation: "ACME/WIDGET",
            beforeMs: Date.parse("2026-07-03T00:00:00.000Z"),
            channelId: "CARCHIVE",
            status: "done",
          },
          limit: 10,
          scope: tenantScope,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ conversationId: targetConversationId }),
      ]);

      await expect(
        searchConversationBriefs(db, {
          currentConversationId,
          filters: { query: "browser launch" },
          limit: 10,
          scope: { kind: "public" },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ conversationId: publicLocalId }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
