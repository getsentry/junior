import { CONVERSATION_DETAIL_VERSION_HEADER } from "@/api/schema";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import { renameConversationResponseSchema } from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, viewer };
}

function rename(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  title: string,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/title`,
    {
      body: JSON.stringify({ title }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

describe("conversation rename API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("lets a participant rename a conversation for every viewer", async () => {
    const conversationId = "local:test:rename";
    const store = getConversationStore();
    await store.recordActivity({
      conversationId,
      destination: { platform: "local", conversationId },
      nowMs: 1_000,
      source: "internal",
      title: "Generated title",
      visibility: "public",
    });
    const owner = await authenticatedApi("renamer@example.com");
    const reader = await authenticatedApi("reader@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1_000),
        rootConversationId: conversationId,
        userId: owner.viewer.id,
      });

    const detailPath = `http://localhost/api/conversations/${conversationId}`;
    const etag = (await owner.app.request(detailPath)).headers.get(
      CONVERSATION_DETAIL_VERSION_HEADER,
    )!;

    // A reader who is not a participant cannot change the shared title.
    expect((await rename(reader.app, conversationId, "Taken")).status).toBe(
      404,
    );
    expect((await rename(owner.app, conversationId, "   ")).status).toBe(400);

    const response = await rename(
      owner.app,
      conversationId,
      "  Checkout fix  ",
    );
    expect(response.status).toBe(200);
    expect(
      renameConversationResponseSchema.parse(await response.json()),
    ).toEqual({ title: "Checkout fix" });

    const feed = await readConversationFeed({ viewer: owner.viewer });
    expect(
      feed.conversations.find((item) => item.conversationId === conversationId)
        ?.displayTitle,
    ).toBe("Checkout fix");
    // An open detail page revalidates and gets the new title.
    const detail = await reader.app.request(detailPath, {
      headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: etag },
    });
    expect(detail.status).toBe(200);

    // Automatic titles are set once, so later activity keeps the rename.
    await store.recordActivity({
      conversationId,
      nowMs: 2_000,
      title: "Another generated title",
    });
    await expect(
      readConversationDetail(conversationId, { viewer: reader.viewer }),
    ).resolves.toMatchObject({ displayTitle: "Checkout fix" });
  });
});
