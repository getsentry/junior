import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationDetailReportSchema } from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";

describe("conversation detail API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns newly appended events when refreshed", async () => {
    const conversationId = "internal:refreshed-detail";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 1,
      source: "internal",
      title: "Refreshed conversation",
    });

    const app = createJuniorApi();
    const detailResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const detail = conversationDetailReportSchema.parse(
      await detailResponse.json(),
    );
    expect(detail.events).toEqual([]);

    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: 2,
        data: {
          messageId: "first-message",
          role: "assistant",
          text: "first-message",
          type: "message",
        },
      },
    ]);
    const refreshedResponse = await app.request(
      `http://localhost/api/conversations/${conversationId}`,
    );
    const refreshed = conversationDetailReportSchema.parse(
      await refreshedResponse.json(),
    );
    expect(refreshed.events.map((event) => event.seq)).toEqual([0]);
  });
});
