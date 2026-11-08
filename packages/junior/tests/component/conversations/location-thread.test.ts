import { describe, expect, it } from "vitest";
import { startLocationThread } from "@/chat/conversations/sql/location";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createJuniorSqlFixture } from "../../fixtures/sql";

const CONVERSATION_ID = "agent-dispatch:dispatch-1";
const BINDING = {
  conversationId: CONVERSATION_ID,
  provider: "slack",
  providerDestinationId: "C123",
  providerTenantId: "T123",
};

describe("Conversation Location thread", () => {
  it("stores the first same-channel post as the Location thread", async () => {
    const fixture = await createJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      await store.recordActivity({
        conversationId: CONVERSATION_ID,
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        nowMs: 1_000,
      });

      await startLocationThread(fixture.sql, {
        ...BINDING,
        providerDestinationId: "D123",
        providerConversationId: "1700000000.000100",
      });
      const before = await store.get({ conversationId: CONVERSATION_ID });
      expect(before?.location).toMatchObject({ channelId: "C123" });
      expect(before?.location).not.toHaveProperty("threadTs");

      await startLocationThread(fixture.sql, {
        ...BINDING,
        providerConversationId: "1700000000.000200",
      });
      await startLocationThread(fixture.sql, {
        ...BINDING,
        providerConversationId: "1700000000.000300",
      });
      await expect(
        store.get({ conversationId: CONVERSATION_ID }),
      ).resolves.toMatchObject({
        location: { channelId: "C123", threadTs: "1700000000.000200" },
      });
    } finally {
      await fixture.close();
    }
  });
});
