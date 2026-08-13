import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  apiErrorSchema,
  conversationDetailReportSchema,
  publishConversationResponseSchema,
} from "@/api/schema";
import { closeDb, getConversationStore } from "@/chat/db";
import { testViewer } from "../../../fixtures/user";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("conversation publish API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("lets a participant publish a private conversation", async () => {
    const conversationId = "local:web:publish-private";
    await getConversationStore().recordActivity({
      actor: {
        email: "owner@example.com",
        fullName: "Owner Example",
      },
      conversationId,
      destination: {
        conversationId,
        platform: "local",
      },
      nowMs: 1_000,
      source: "web",
      title: "Private web conversation",
      visibility: "private",
    });

    const stranger = authenticatedApi("stranger@example.com");
    const denied = await stranger.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/publish`,
      { method: "POST" },
    );
    expect(denied.status).toBe(403);
    expect(apiErrorSchema.parse(await denied.json())).toEqual({
      error: "Only conversation participants can make this public.",
    });

    const owner = authenticatedApi("owner@example.com");
    const published = await owner.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/publish`,
      { method: "POST" },
    );
    expect(published.status).toBe(200);
    expect(publishConversationResponseSchema.parse(await published.json())).toEqual({
      visibility: "public",
    });

    const again = await owner.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/publish`,
      { method: "POST" },
    );
    expect(again.status).toBe(200);
    expect(publishConversationResponseSchema.parse(await again.json())).toEqual({
      visibility: "public",
    });

    const detail = await stranger.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
    );
    expect(detail.status).toBe(200);
    expect(conversationDetailReportSchema.parse(await detail.json())).toMatchObject({
      conversationId,
      visibility: "public",
    });
  });

  it("requires authentication and a real conversation", async () => {
    const app = createJuniorApi();
    const unauthenticated = await app.request(
      "http://localhost/api/conversations/missing/publish",
      { method: "POST" },
    );
    expect(unauthenticated.status).toBe(401);

    const missing = await authenticatedApi("owner@example.com").request(
      "http://localhost/api/conversations/missing/publish",
      { method: "POST" },
    );
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json())).toEqual({
      error: "Conversation not found.",
    });
  });
});
