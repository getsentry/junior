import { CONVERSATION_DETAIL_VERSION_HEADER } from "@/api/schema";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  pinConversationResponseSchema,
  reorderPinnedConversationsResponseSchema,
} from "@/api/schema";
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

async function storeConversation(args: {
  conversationId: string;
  nowMs: number;
  visibility: "private" | "public";
}) {
  await getConversationStore().recordActivity({
    conversationId: args.conversationId,
    destination: { platform: "local", conversationId: args.conversationId },
    nowMs: args.nowMs,
    source: "internal",
    title: args.conversationId,
    visibility: args.visibility,
  });
}

async function addParticipant(conversationId: string, userId: string) {
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(1_000),
      rootConversationId: conversationId,
      userId,
    });
}

function setPin(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  pinned: boolean,
) {
  return app.request(
    `http://localhost/api/conversations/${conversationId}/pin`,
    {
      body: JSON.stringify({ pinned }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

function setPinOrder(app: Hono<JuniorApiEnv>, conversationIds: string[]) {
  return app.request("http://localhost/api/conversations/pin-order", {
    body: JSON.stringify({ conversationIds }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

async function pinPositions(
  viewer: Awaited<ReturnType<typeof authenticatedApi>>["viewer"],
) {
  const feed = await readConversationFeed({ viewer });
  return Object.fromEntries(
    feed.conversations.map((conversation) => [
      conversation.conversationId,
      conversation.pinPosition,
    ]),
  );
}

async function feedIds(viewer: Parameters<typeof readConversationFeed>[0]) {
  const feed = await readConversationFeed(viewer);
  return feed.conversations.map((conversation) => ({
    conversationId: conversation.conversationId,
    pinned: Boolean(conversation.pinnedAt),
  }));
}

describe("conversation pin API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("sorts the viewer's pins first and unpins on archive", async () => {
    const older = "local:test:pin-older";
    const newer = "local:test:pin-newer";
    await storeConversation({
      conversationId: older,
      nowMs: 1_000,
      visibility: "private",
    });
    await storeConversation({
      conversationId: newer,
      nowMs: 2_000,
      visibility: "private",
    });
    const { app, viewer } = await authenticatedApi("pinner@example.com");
    const other = await authenticatedApi("other@example.com");
    for (const id of [older, newer]) {
      await addParticipant(id, viewer.id);
      await addParticipant(id, other.viewer.id);
    }

    const detailPath = `http://localhost/api/conversations/${older}`;
    const unpinnedEtag = (await app.request(detailPath)).headers.get(
      CONVERSATION_DETAIL_VERSION_HEADER,
    )!;

    const pin = await setPin(app, older, true);
    expect(pin.status).toBe(200);
    expect(pinConversationResponseSchema.parse(await pin.json())).toEqual({
      pinnedAt: expect.any(String),
    });
    // The older pinned root sorts before newer activity, so it stays inside
    // the feed limit.
    await expect(feedIds({ viewer })).resolves.toEqual([
      { conversationId: older, pinned: true },
      { conversationId: newer, pinned: false },
    ]);
    await expect(feedIds({ viewer: other.viewer })).resolves.toEqual([
      { conversationId: newer, pinned: false },
      { conversationId: older, pinned: false },
    ]);
    // A child pin is not a pin of its root, so the API refuses it.
    const child = "agent:pin-child";
    await getConversationStore().createChild({
      childConversationId: child,
      kind: "task",
      parentConversationId: newer,
    });
    const childPin = await setPin(app, child, true);
    expect(childPin.status).toBe(409);
    await expect(childPin.json()).resolves.toEqual({
      error:
        "Only a top-level conversation can be pinned. Pin its root instead.",
    });
    await expect(feedIds({ viewer })).resolves.toEqual([
      { conversationId: older, pinned: true },
      { conversationId: newer, pinned: false },
    ]);
    // A pin is viewer state, so an open detail page revalidates.
    const pinnedDetail = await app.request(detailPath, {
      headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: unpinnedEtag },
    });
    expect(pinnedDetail.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(await pinnedDetail.json()).pinnedAt,
    ).toEqual(expect.any(String));

    const archive = await app.request(
      `http://localhost/api/conversations/${older}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: new Date(1_000).toISOString(),
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(older, { viewer }),
      ).pinnedAt,
    ).toBeNull();
  });

  it("keeps the viewer's Pinned order until a pin changes", async () => {
    const [first, second, third, unpinned] = [
      "local:test:pin-order-first",
      "local:test:pin-order-second",
      "local:test:pin-order-third",
      "local:test:pin-order-unpinned",
    ];
    const { app, viewer } = await authenticatedApi("orderer@example.com");
    const other = await authenticatedApi("order-other@example.com");
    for (const [index, id] of [first, second, third, unpinned].entries()) {
      await storeConversation({
        conversationId: id,
        nowMs: 1_000 + index,
        visibility: "private",
      });
      await addParticipant(id, viewer.id);
      await addParticipant(id, other.viewer.id);
    }
    for (const id of [first, second, third]) {
      expect((await setPin(app, id, true)).status).toBe(200);
    }
    expect((await setPin(other.app, first, true)).status).toBe(200);

    // An unpinned id gets no place.
    const reorder = await setPinOrder(app, [third, first, unpinned, second]);
    expect(reorder.status).toBe(200);
    expect(
      reorderPinnedConversationsResponseSchema.parse(await reorder.json()),
    ).toEqual({ conversationIds: [third, first, second] });
    await expect(pinPositions(viewer)).resolves.toEqual({
      [first]: 1,
      [second]: 3,
      [third]: 0,
      [unpinned]: undefined,
    });
    // The order belongs to the viewer.
    await expect(pinPositions(other.viewer)).resolves.toEqual({
      [first]: undefined,
      [second]: undefined,
      [third]: undefined,
      [unpinned]: undefined,
    });

    // A placed pin that the list leaves out moves after the listed pins.
    expect((await setPinOrder(app, [second, third])).status).toBe(200);
    await expect(pinPositions(viewer)).resolves.toMatchObject({
      [first]: 3,
      [second]: 0,
      [third]: 1,
    });

    // A pin made again has no place, so it sorts first.
    await setPin(app, first, false);
    await setPin(app, first, true);
    expect((await pinPositions(viewer))[first]).toBeUndefined();

    expect((await setPinOrder(app, [second, second])).status).toBe(400);
  });

  it("lets only participants pin, so a pin grants no access", async () => {
    const shared = "local:test:pin-public";
    const hidden = "local:test:pin-private";
    await storeConversation({
      conversationId: shared,
      nowMs: 1_000,
      visibility: "public",
    });
    await storeConversation({
      conversationId: hidden,
      nowMs: 1_000,
      visibility: "private",
    });
    const { app, viewer } = await authenticatedApi("reader@example.com");

    // A reader of a public conversation is not a participant. A pin would add
    // a participant row, which grants send and control access.
    expect((await setPin(app, shared, true)).status).toBe(404);
    expect((await setPin(app, hidden, true)).status).toBe(404);
    await expect(feedIds({ viewer })).resolves.toEqual([]);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(shared, { viewer }),
      ).isParticipant,
    ).toBe(false);
  });
});
