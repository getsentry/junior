import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { ConversationMessageRole } from "@/chat/conversations/messages";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlConversationMessageSearchStore } from "@/chat/conversations/sql/message-search";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("conversation message search", () => {
  it("returns only public user and assistant messages from the authorized workspace", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const conversations = createSqlStore(fixture.sql);
      const events = createSqlConversationEventStore(fixture.sql);
      const search = createSqlConversationMessageSearchStore(fixture.sql);

      const seed = async (args: {
        channelId: string;
        channelName?: string;
        conversationId: string;
        message: string;
        role?: ConversationMessageRole;
        teamId?: string;
        visibility: ConversationPrivacy;
      }) => {
        await conversations.recordActivity({
          conversationId: args.conversationId,
          destination: {
            platform: "slack",
            teamId: args.teamId ?? "T123",
            channelId: args.channelId,
          },
          nowMs: 1_750_000_000_000,
          source: "slack",
          visibility: args.visibility,
          ...(args.channelName ? { channelName: args.channelName } : {}),
        });
        await events.append(args.conversationId, [
          {
            data: {
              type: "message",
              messageId: `${args.conversationId}:message`,
              role: args.role ?? "user",
              text: args.message,
            },
            createdAtMs: 1_750_000_000_000,
          },
        ]);
      };

      await seed({
        channelId: "CREQUEST",
        conversationId: "slack:CREQUEST:1700000000.100000",
        message: "The current launch checklist thread must be excluded.",
        visibility: "public",
      });
      await seed({
        channelId: "CREQUEST",
        channelName: "launch",
        conversationId: "slack:CREQUEST:1700000000.200000",
        message: "The launch checklist needs a rollback owner.",
        visibility: "public",
      });
      await seed({
        channelId: "CARCHIVE",
        channelName: "archive",
        conversationId: "slack:CARCHIVE:1700000000.300000",
        message: "The launch checklist also needs a database backup step.",
        role: "assistant",
        visibility: "public",
      });
      await seed({
        channelId: "CPRIVATE",
        conversationId: "slack:CPRIVATE:1700000000.400000",
        message: "A private launch checklist secret.",
        visibility: "private",
      });
      await seed({
        channelId: "COTHERWORKSPACE",
        conversationId: "slack:COTHERWORKSPACE:1700000000.500000",
        message: "Another workspace launch checklist secret.",
        teamId: "TOTHER",
        visibility: "public",
      });
      await seed({
        channelId: "CSYSTEM",
        conversationId: "slack:CSYSTEM:1700000000.600000",
        message: "A system launch checklist instruction.",
        role: "system",
        visibility: "public",
      });

      const results = await search.search({
        currentConversationId: "slack:CREQUEST:1700000000.100000",
        filters: { query: "launch checklist" },
        limit: 10,
        scope: {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: "T123",
        },
      });

      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            channelName: "launch",
            conversationId: "slack:CREQUEST:1700000000.200000",
            providerDestinationId: "CREQUEST",
            role: "user",
          }),
          expect.objectContaining({
            channelName: "archive",
            conversationId: "slack:CARCHIVE:1700000000.300000",
            providerDestinationId: "CARCHIVE",
            role: "assistant",
          }),
        ]),
      );
      expect(results.map((result) => result.excerpt).join(" ")).not.toMatch(
        /private|system|other workspace/i,
      );

      const channelOnly = await search.search({
        currentConversationId: "slack:CREQUEST:1700000000.100000",
        filters: { channelId: "CARCHIVE" },
        limit: 10,
        scope: {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: "T123",
        },
      });
      expect(channelOnly).toEqual([
        expect.objectContaining({
          conversationId: "slack:CARCHIVE:1700000000.300000",
          providerDestinationId: "CARCHIVE",
        }),
      ]);

      const combined = await search.search({
        currentConversationId: "slack:CREQUEST:1700000000.100000",
        filters: {
          channelId: "CREQUEST",
          query: "rollback",
        },
        limit: 10,
        scope: {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: "T123",
        },
      });
      expect(combined).toEqual([
        expect.objectContaining({
          conversationId: "slack:CREQUEST:1700000000.200000",
        }),
      ]);

      await createPluginAnnotations({
        conversationId: "slack:CARCHIVE:1700000000.300000",
        db: fixture.sql.db(),
        plugin: "code-host",
      }).upsert({
        kind: "resource_link",
        key: "acme/widget_v2#12",
        label: "acme/widget_v2#12",
        url: "https://code.example/acme/widget_v2/changes/12",
      });
      await createPluginAnnotations({
        conversationId: "slack:CREQUEST:1700000000.200000",
        db: fixture.sql.db(),
        plugin: "code-host",
      }).upsert({
        kind: "resource_link",
        key: "acme/widget_v2extra#9",
        label: "acme/widget_v2extra#9",
        url: "https://code.example/acme/widget_v2extra/issues/9",
      });
      await seed({
        channelId: "CNEST",
        channelName: "nested",
        conversationId: "slack:CNEST:1700000000.700000",
        message: "A longer nested resource id should stay distinct.",
        visibility: "public",
      });
      await createPluginAnnotations({
        conversationId: "slack:CNEST:1700000000.700000",
        db: fixture.sql.db(),
        plugin: "code-host",
      }).upsert({
        kind: "resource_link",
        key: "acme/widget_v2#123",
        label: "acme/widget_v2#123",
        url: "https://code.example/acme/widget_v2/changes/123",
      });

      const annotated = await search.search({
        currentConversationId: "slack:CREQUEST:1700000000.100000",
        filters: {
          afterMs: 1_749_999_999_000,
          beforeMs: 1_750_000_001_000,
          annotation: "ACME/WIDGET_V2",
        },
        limit: 10,
        scope: {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: "T123",
        },
      });
      expect(annotated).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversationId: "slack:CARCHIVE:1700000000.300000",
          }),
          expect.objectContaining({
            conversationId: "slack:CNEST:1700000000.700000",
          }),
        ]),
      );
      expect(annotated).toHaveLength(2);

      const exactNested = await search.search({
        currentConversationId: "slack:CREQUEST:1700000000.100000",
        filters: {
          annotation: "acme/widget_v2#12",
        },
        limit: 10,
        scope: {
          kind: "public_provider_tenant",
          provider: "slack",
          providerTenantId: "T123",
        },
      });
      expect(exactNested).toEqual([
        expect.objectContaining({
          conversationId: "slack:CARCHIVE:1700000000.300000",
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
