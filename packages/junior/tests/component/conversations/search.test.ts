import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  storeBriefEmbedding,
  type BriefEmbedder,
} from "@/chat/briefs/embedding";
import { appendConversationBrief } from "@/chat/briefs/store";
import { searchConversations } from "@/chat/conversations/search";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { juniorConversations } from "@/db/schema";
import { conversationBriefFixture } from "../../fixtures/conversation-brief";
import { createJuniorSqlFixture } from "../../fixtures/sql";

describe("Conversation search", () => {
  it("searches the latest Brief of public roots of every surface", async () => {
    const fixture = await createJuniorSqlFixture();
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
        kind: "task",
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
        summary: "The child deployment decision is a child agent.",
        turnId: "child-turn",
      });
      await append({
        conversationId: publicLocalId,
        searchText: "browser launch decision",
        summary: "The browser launch decision is public.",
        turnId: "local-turn",
      });
      const updatedAt = new Date("2026-07-02T12:00:00.000Z");
      // A purged transcript keeps its Brief searchable.
      await db
        .update(juniorConversations)
        .set({
          lastActivityAt: updatedAt,
          transcriptPurgedAt: new Date("2026-07-03T12:00:00.000Z"),
        })
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

      const deploymentMatches = await searchConversations(db, {
        requesterConversationId: currentConversationId,
        search: {
          includeArchived: false,
          rootsOnly: true,
          limit: 10,
          query: "deployment decision",
        },
      });
      // Public is public: another workspace matches; private, child, and
      // current Conversations do not.
      expect(
        deploymentMatches.map((match) => match.conversationId).sort(),
      ).toEqual([otherTenantId, targetConversationId].sort());

      // Child agents match only when the search asks for them.
      const withChildren = await searchConversations(db, {
        requesterConversationId: currentConversationId,
        search: {
          includeArchived: false,
          limit: 10,
          query: "child deployment decision",
          rootsOnly: false,
        },
      });
      expect(withChildren).toContainEqual(
        expect.objectContaining({
          kind: "task",
          conversationId: childId,
          rootConversationId: targetConversationId,
        }),
      );

      // Auto-archive marks only the root. Its child agents are archived too.
      await db
        .update(juniorConversations)
        .set({ archivedAt: new Date("2026-07-04T12:00:00.000Z") })
        .where(eq(juniorConversations.conversationId, targetConversationId));
      const childSearch = {
        limit: 10,
        query: "child deployment decision",
        rootsOnly: false,
      };
      await expect(
        searchConversations(db, {
          requesterConversationId: currentConversationId,
          search: { ...childSearch, includeArchived: false },
        }),
      ).resolves.not.toContainEqual(
        expect.objectContaining({ conversationId: childId }),
      );
      await expect(
        searchConversations(db, {
          requesterConversationId: currentConversationId,
          search: { ...childSearch, includeArchived: true },
        }),
      ).resolves.toContainEqual(
        expect.objectContaining({ archived: true, conversationId: childId }),
      );
      await db
        .update(juniorConversations)
        .set({ archivedAt: null })
        .where(eq(juniorConversations.conversationId, targetConversationId));

      const matches = await searchConversations(db, {
        requesterConversationId: currentConversationId,
        search: {
          includeArchived: false,
          rootsOnly: true,
          limit: 10,
          query: "blue rollout",
        },
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
          transcriptPurged: true,
          updatedAtMs: updatedAt.getTime(),
        }),
      ]);
      expect(matches[0]?.links).toHaveLength(5);
      expect(matches[0]?.excerpt).toContain("**blue**");

      await expect(
        searchConversations(db, {
          requesterConversationId: currentConversationId,
          search: {
            includeArchived: false,
            rootsOnly: true,
            limit: 10,
            query: "obsolete migration",
          },
        }),
      ).resolves.toEqual([]);

      await expect(
        searchConversations(db, {
          requesterConversationId: currentConversationId,
          search: {
            includeArchived: false,
            rootsOnly: true,
            limit: 10,
            afterMs: Date.parse("2026-07-02T00:00:00.000Z"),
            annotation: "ACME/WIDGET",
            beforeMs: Date.parse("2026-07-03T00:00:00.000Z"),
            channelId: "CARCHIVE",
            outcomeStatus: "done",
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ conversationId: targetConversationId }),
      ]);

      await expect(
        searchConversations(db, {
          requesterConversationId: currentConversationId,
          search: {
            includeArchived: false,
            rootsOnly: true,
            limit: 10,
            query: "browser launch",
          },
        }),
      ).resolves.toEqual([
        expect.objectContaining({ conversationId: publicLocalId }),
      ]);
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it("finds Briefs by meaning above the similarity floor, with the same access rules", async () => {
    const fixture = await createJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const db = fixture.sql.db();
      const conversations = createSqlStore(fixture.sql);
      const requesterId = "slack:CREQUEST:1700000000.100000";
      const paraphraseId = "slack:CROLLOUT:1700000000.200000";
      const unrelatedId = "slack:CBILLING:1700000000.300000";
      const privateId = "slack:CPRIVATE:1700000000.400000";
      const staleId = "slack:CSTALE:1700000000.500000";
      const rollout = "Roll the release out to production in stages";
      const query = "ship a new build to prod gradually";
      // Fake model: one axis per topic. The query is close to the rollout
      // Briefs and far from the invoice Brief.
      const vectors: Record<string, number[]> = {
        [rollout]: [1, 0, 0],
        [query]: [0.9, 0.2, 0],
        "Quarterly invoice totals": [0, 1, 0],
        "Stale rollout notes": [1, 0, 0],
        "Notes about lunch": [0, 0, 1],
      };
      const embedder: BriefEmbedder = async ({ text }) => {
        const vector = vectors[text];
        if (!vector) throw new Error(`No test vector for ${text}`);
        return { model: "test-embedding", provider: "test", vector };
      };
      const seed = async (args: {
        channelId: string;
        conversationId: string;
        searchTexts: string[];
        visibility: "private" | "public";
      }) => {
        await conversations.recordActivity({
          conversationId: args.conversationId,
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: args.channelId,
          },
          nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
          source: "slack",
          title: `Title for ${args.channelId}`,
          visibility: args.visibility,
        });
        for (const [index, searchText] of args.searchTexts.entries()) {
          const stored = await appendConversationBrief(db, {
            conversationId: args.conversationId,
            turnId: `turn-${index}`,
            throughSeq: index + 1,
            content: conversationBriefFixture({ summary: searchText }),
            searchText,
            modelId: "test-model",
          });
          // Only the first Brief is embedded, so a later Brief makes the
          // vector stale.
          if (index === 0) {
            await storeBriefEmbedding(db, embedder, stored.value);
          }
        }
      };
      await seed({
        channelId: "CREQUEST",
        conversationId: requesterId,
        searchTexts: [rollout],
        visibility: "public",
      });
      await seed({
        channelId: "CROLLOUT",
        conversationId: paraphraseId,
        searchTexts: [rollout],
        visibility: "public",
      });
      await seed({
        channelId: "CBILLING",
        conversationId: unrelatedId,
        searchTexts: ["Quarterly invoice totals"],
        visibility: "public",
      });
      await seed({
        channelId: "CPRIVATE",
        conversationId: privateId,
        searchTexts: [rollout],
        visibility: "private",
      });
      await seed({
        channelId: "CSTALE",
        conversationId: staleId,
        searchTexts: ["Stale rollout notes", "Notes about lunch"],
        visibility: "public",
      });
      const search = {
        includeArchived: false,
        limit: 10,
        query,
        rootsOnly: true,
      };

      // The query shares no word with any Brief, so only the vector of the
      // public rollout Brief matches. The invoice Brief is under the floor,
      // and private, own-tree, and stale vectors never count.
      await expect(
        searchConversations(db, {
          embedder,
          requesterConversationId: requesterId,
          search,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          conversationId: paraphraseId,
          summary: rollout,
        }),
      ]);
      // Without an embedder, search matches words only.
      await expect(
        searchConversations(db, {
          requesterConversationId: requesterId,
          search,
        }),
      ).resolves.toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
