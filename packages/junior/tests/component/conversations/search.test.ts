import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PluginEmbedder } from "@sentry/junior-plugin-api";
import { storeConversationEmbedding } from "@/chat/conversations/embedding";
import { searchConversations } from "@/chat/conversations/search";
import { resolveAnnotationFilter } from "@/chat/conversations/sql/annotation-filter";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { juniorConversations } from "@/db/schema";
import { readConversationMetadata } from "@/chat/conversations/metadata/store";
import { storeConversationMetadataFixture } from "../../fixtures/conversation-metadata";
import { createJuniorSqlFixture } from "../../fixtures/sql";

describe("Conversation search", () => {
  it("searches the summary of public roots of every surface", async () => {
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
        title: "Public web summary",
        visibility: "public",
      });

      let throughSeq = 0;
      const append = async (args: {
        conversationId: string;
        summary: string;
      }) =>
        await storeConversationMetadataFixture(db, {
          conversationId: args.conversationId,
          summary: args.summary,
          throughSeq: (throughSeq += 1),
        });

      await append({
        conversationId: currentConversationId,
        summary: "The current deployment decision stays excluded.",
      });
      await append({
        conversationId: targetConversationId,
        summary: "The obsolete migration choice was replaced.",
      });
      await append({
        conversationId: targetConversationId,
        summary: "The deployment decision uses the blue rollout.",
      });
      await append({
        conversationId: otherTenantId,
        summary: "Another workspace has a deployment decision.",
      });
      await append({
        conversationId: privateId,
        summary: "The private deployment decision stays private.",
      });
      await append({
        conversationId: childId,
        summary: "The child deployment decision is a child agent.",
      });
      await append({
        conversationId: publicLocalId,
        summary: "The browser launch decision is public.",
      });
      const updatedAt = new Date("2026-07-02T12:00:00.000Z");
      // A purged public transcript keeps its summary searchable.
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

      // A root whose first Turn has not completed has a title but no summary.
      const unsummarizedId = "slack:CTITLE:1700000000.600000";
      await conversations.recordActivity({
        channelName: "ctitle-name",
        conversationId: unsummarizedId,
        destination: { platform: "slack", teamId: "T123", channelId: "CTITLE" },
        nowMs: Date.parse("2026-07-01T12:00:00.000Z"),
        source: "slack",
        title: "Deployment decision in progress",
        visibility: "public",
      });
      const titleSearch = {
        includeArchived: false,
        limit: 10,
        query: "deployment decision",
        rootsOnly: true,
      };
      expect(
        (
          await searchConversations(db, {
            requesterConversationId: currentConversationId,
            search: titleSearch,
          })
        ).map((match) => match.conversationId),
      ).toContain(unsummarizedId);

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
          links: [
            {
              label: "acme/widget#12",
              url: "https://example.com/acme/widget/12",
            },
          ],
          providerDestinationId: "CARCHIVE",
          summary: "The deployment decision uses the blue rollout.",
          title: "Title for CARCHIVE",
          transcriptPurged: true,
          updatedAtMs: updatedAt.getTime(),
        }),
      ]);
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
            annotation: await resolveAnnotationFilter(db, "ACME/WIDGET"),
            beforeMs: Date.parse("2026-07-03T00:00:00.000Z"),
            channelId: "CARCHIVE",
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

  it("finds summaries by meaning above the similarity floor, with the same access rules", async () => {
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
      // summaries and far from the invoice summary.
      const vectors: Record<string, number[]> = {
        [rollout]: [1, 0, 0],
        [query]: [0.9, 0.2, 0],
        "Quarterly invoice totals": [0, 1, 0],
        "Stale rollout notes": [1, 0, 0],
        "Notes about lunch": [0, 0, 1],
      };
      // A document is the title, then the summary on its last line.
      const embedder: PluginEmbedder = {
        model: "test-embedding",
        provider: "test",
        async embedTexts({ texts }) {
          return {
            dimensions: 3,
            model: "test-embedding",
            provider: "test",
            vectors: texts.map((text) => {
              const vector = vectors[text.split("\n").at(-1)!];
              if (!vector) throw new Error(`No test vector for ${text}`);
              return vector;
            }),
          };
        },
      };
      const seed = async (args: {
        channelId: string;
        conversationId: string;
        summaries: string[];
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
        for (const [index, summary] of args.summaries.entries()) {
          await storeConversationMetadataFixture(db, {
            conversationId: args.conversationId,
            summary,
            throughSeq: index + 1,
          });
          // Only the first summary is embedded, so a later one makes the
          // vector stale.
          if (index === 0) {
            await storeConversationEmbedding(db, embedder, {
              conversationId: args.conversationId,
              metadata: (await readConversationMetadata(
                db,
                args.conversationId,
              ))!,
            });
          }
        }
      };
      await seed({
        channelId: "CREQUEST",
        conversationId: requesterId,
        summaries: [rollout],
        visibility: "public",
      });
      await seed({
        channelId: "CROLLOUT",
        conversationId: paraphraseId,
        summaries: [rollout],
        visibility: "public",
      });
      await seed({
        channelId: "CBILLING",
        conversationId: unrelatedId,
        summaries: ["Quarterly invoice totals"],
        visibility: "public",
      });
      await seed({
        channelId: "CPRIVATE",
        conversationId: privateId,
        summaries: [rollout],
        visibility: "private",
      });
      await seed({
        channelId: "CSTALE",
        conversationId: staleId,
        summaries: ["Stale rollout notes", "Notes about lunch"],
        visibility: "public",
      });
      const search = {
        includeArchived: false,
        limit: 10,
        query,
        rootsOnly: true,
      };

      // The query shares no word with any summary, so only the vector of the
      // public rollout summary matches. The invoice summary is under the floor,
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
