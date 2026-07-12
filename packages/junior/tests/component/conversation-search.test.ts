import { describe, expect, it } from "vitest";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import type { ConversationMessageRole } from "@/chat/conversations/messages";
import { createSqlConversationMessageStore } from "@/chat/conversations/sql/messages";
import { createSqlConversationSearchStore } from "@/chat/conversations/sql/search";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";

describe("conversation search", () => {
  it("returns only public user and assistant messages from the authorized workspace", async () => {
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const conversations = createSqlStore(fixture.sql);
      const messages = createSqlConversationMessageStore(fixture.sql);
      const search = createSqlConversationSearchStore(fixture.sql);

      const seed = async (args: {
        channelId: string;
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
        });
        await messages.record(args.conversationId, [
          {
            messageId: `${args.conversationId}:message`,
            role: args.role ?? "user",
            text: args.message,
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
        conversationId: "slack:CREQUEST:1700000000.200000",
        message: "The launch checklist needs a rollback owner.",
        visibility: "public",
      });
      await seed({
        channelId: "CARCHIVE",
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
        limit: 10,
        query: "launch checklist",
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
            conversationId: "slack:CREQUEST:1700000000.200000",
            providerDestinationId: "CREQUEST",
            role: "user",
          }),
          expect.objectContaining({
            conversationId: "slack:CARCHIVE:1700000000.300000",
            providerDestinationId: "CARCHIVE",
            role: "assistant",
          }),
        ]),
      );
      expect(results.map((result) => result.excerpt).join(" ")).not.toMatch(
        /private|system|other workspace/i,
      );
    } finally {
      await fixture.close();
    }
  });
});
