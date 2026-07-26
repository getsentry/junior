import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import {
  apiErrorSchema,
  archiveConversationResponseSchema,
} from "@/api/schema";
import { closeDb, getConversationStore } from "@/chat/db";

describe("conversation archive API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("archives and restores a conversation", async () => {
    const conversationId = "internal:archive-route";
    const lastSeenAt = "1970-01-01T00:00:01.000Z";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: Date.parse(lastSeenAt),
      source: "internal",
      title: "Archive route",
    });

    const app = createJuniorApi();
    for (const archived of [true, false]) {
      const response = await app.request(
        `http://localhost/api/conversations/${conversationId}/archive`,
        {
          body: JSON.stringify({ archived, lastSeenAt }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      expect(response.status).toBe(200);
      expect(
        archiveConversationResponseSchema.parse(await response.json()),
      ).toEqual({ archived });
    }
  });

  it("rejects invalid input and stale activity", async () => {
    const conversationId = "internal:archive-conflict";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 1_000,
      source: "internal",
    });
    const app = createJuniorApi();

    const invalid = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({ archived: "yes" }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(invalid.status).toBe(400);
    expect(apiErrorSchema.parse(await invalid.json())).toEqual({
      error: "Invalid request body.",
    });

    const stale = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: "1970-01-01T00:00:00.999Z",
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(stale.status).toBe(409);
    expect(apiErrorSchema.parse(await stale.json())).toEqual({
      error: "Conversation received new activity.",
    });
  });
});
