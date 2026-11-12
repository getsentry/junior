import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import type { JuniorApiEnv } from "@/api/route";
import { conversationDeliveryResponseSchema } from "@/api/schema";
import { isConversationDeliveryPaused } from "@/chat/conversations/delivery-pause";
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

function setDelivery(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  paused: boolean,
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/delivery`,
    {
      body: JSON.stringify({ paused }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

describe("conversation delivery API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("lets a participant detach a Slack thread conversation and attach it again", async () => {
    const conversationId = "slack:C123:1700000000.000100";
    const webConversationId = "local:test:delivery";
    const store = getConversationStore();
    await store.recordActivity({
      conversationId,
      destination: { platform: "slack", teamId: "T123", channelId: "C123" },
      nowMs: 1_000,
      sessionSource: {
        kind: "slack",
        visibility: "public",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000100",
      },
      source: "slack",
      visibility: "public",
    });
    await store.recordActivity({
      conversationId: webConversationId,
      destination: { platform: "local", conversationId: webConversationId },
      nowMs: 1_000,
      source: "internal",
      visibility: "public",
    });
    const owner = await authenticatedApi("detacher@example.com");
    const reader = await authenticatedApi("reader@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values(
        [conversationId, webConversationId].map((rootConversationId) => ({
          lastMessageAt: new Date(1_000),
          rootConversationId,
          userId: owner.viewer.id,
        })),
      );

    // Only participants see and change it, and only with a Slack thread.
    expect((await setDelivery(reader.app, conversationId, true)).status).toBe(
      404,
    );
    expect((await setDelivery(owner.app, webConversationId, true)).status).toBe(
      409,
    );
    await expect(
      readConversationDetail(conversationId, { viewer: reader.viewer }),
    ).resolves.not.toHaveProperty("deliveryPaused");
    await expect(
      readConversationDetail(webConversationId, { viewer: owner.viewer }),
    ).resolves.not.toHaveProperty("deliveryPaused");
    await expect(
      readConversationDetail(conversationId, { viewer: owner.viewer }),
    ).resolves.toMatchObject({ deliveryPaused: false });

    const detached = await setDelivery(owner.app, conversationId, true);
    expect(detached.status).toBe(200);
    expect(
      conversationDeliveryResponseSchema.parse(await detached.json()),
    ).toEqual({ paused: true });
    await expect(isConversationDeliveryPaused(conversationId)).resolves.toBe(
      true,
    );
    await expect(
      readConversationDetail(conversationId, { viewer: owner.viewer }),
    ).resolves.toMatchObject({ deliveryPaused: true });

    expect((await setDelivery(owner.app, conversationId, false)).status).toBe(
      200,
    );
    await expect(isConversationDeliveryPaused(conversationId)).resolves.toBe(
      false,
    );
  });
});
