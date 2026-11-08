import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  conversationSubscriptionResponseSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";

async function person(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const identityId = `identity:${email}`;
  await getDb()
    .insert(juniorIdentities)
    .values({
      createdAt: new Date(1_000),
      email,
      emailNormalized: email,
      emailVerified: true,
      id: identityId,
      kind: "user",
      provider: "slack",
      providerSubjectId: email,
      providerTenantId: "T1",
      updatedAt: new Date(1_000),
      userId: viewer.id,
    });
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, identityId, viewer };
}

type Person = Awaited<ReturnType<typeof person>>;

async function storeConversation(conversationId: string) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "local", conversationId },
    nowMs: 1_000,
    source: "internal",
    title: conversationId,
    visibility: "public",
  });
}

async function addParticipant(conversationId: string, someone: Person) {
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(1_000),
      rootConversationId: conversationId,
      userId: someone.viewer.id,
    });
}

async function setSubscribed(
  someone: Person,
  conversationId: string,
  subscribed: boolean,
) {
  const response = await someone.app.request(
    `http://localhost/api/conversations/${conversationId}/subscription`,
    {
      body: JSON.stringify({ subscribed }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  expect(response.status).toBe(200);
  return conversationSubscriptionResponseSchema.parse(await response.json());
}

function setPin(someone: Person, conversationId: string, pinned: boolean) {
  return someone.app.request(
    `http://localhost/api/conversations/${conversationId}/pin`,
    {
      body: JSON.stringify({ pinned }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

/** Store one Slack message from the person and start a Turn with it. */
async function startTurn(
  conversationId: string,
  someone: Person,
  args: { explicitMention: boolean; id: string; atMs: number },
) {
  await getConversationEventStore().append(conversationId, [
    {
      createdAtMs: args.atMs,
      data: {
        authorIdentityId: someone.identityId,
        messageId: args.id,
        meta: { explicitMention: args.explicitMention, source: "slack" },
        role: "user",
        text: args.id,
        type: "message",
      },
      idempotencyKey: `message:${args.id}`,
    },
    {
      createdAtMs: args.atMs + 1,
      data: {
        inputMessageIds: [args.id],
        surface: "api",
        turnId: `turn:${args.id}`,
        type: "turn_started",
      },
      idempotencyKey: `turn:${args.id}:started`,
    },
  ]);
}

async function feedIds(someone: Person) {
  const feed = await readConversationFeed({ viewer: someone.viewer });
  return feed.conversations.map((conversation) => conversation.conversationId);
}

async function detail(conversationId: string, someone: Person) {
  return conversationDetailReportSchema.parse(
    await readConversationDetail(conversationId, { viewer: someone.viewer }),
  );
}

describe("conversation subscription API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("hides the conversation from one person until they mention Junior again", async () => {
    const id = "local:test:subscription-handoff";
    await storeConversation(id);
    const leaver = await person("leaver@example.com");
    const owner = await person("owner@example.com");
    await addParticipant(id, leaver);
    await addParticipant(id, owner);
    expect((await setPin(leaver, id, true)).status).toBe(200);

    await expect(setSubscribed(leaver, id, false)).resolves.toEqual({
      archivedAt: null,
      subscribed: false,
    });
    await expect(feedIds(leaver)).resolves.toEqual([]);
    await expect(feedIds(owner)).resolves.toEqual([id]);
    // The leaver keeps access and finds it in search, so they can come back.
    const left = await detail(id, leaver);
    expect(left).toMatchObject({ isParticipant: true, subscribed: false });
    expect(left.pinnedAt).toBeFalsy();
    await expect(
      readConversationFeed({ q: id, viewer: leaver.viewer }),
    ).resolves.toMatchObject({ conversations: [{ conversationId: id }] });

    // Someone else carries on, and the leaver replies without a mention.
    await startTurn(id, owner, {
      atMs: 2_000,
      explicitMention: true,
      id: "owner-mention",
    });
    await startTurn(id, leaver, {
      atMs: 3_000,
      explicitMention: false,
      id: "leaver-passive",
    });
    await expect(feedIds(leaver)).resolves.toEqual([]);

    await startTurn(id, leaver, {
      atMs: 4_000,
      explicitMention: true,
      id: "leaver-mention",
    });
    await expect(feedIds(leaver)).resolves.toEqual([id]);
    expect((await detail(id, leaver)).subscribed).toBe(true);
  });

  it("archives the conversation when the last subscriber leaves", async () => {
    const id = "local:test:subscription-last";
    await storeConversation(id);
    const first = await person("first@example.com");
    const second = await person("second@example.com");
    await addParticipant(id, first);
    await addParticipant(id, second);

    await setSubscribed(first, id, false);
    await expect(setSubscribed(second, id, false)).resolves.toEqual({
      archivedAt: expect.any(String),
      subscribed: false,
    });
    expect((await detail(id, first)).archivedAt).toEqual(expect.any(String));

    // Subscribing again leaves the shared archive alone. A pin restores it.
    await expect(setSubscribed(first, id, true)).resolves.toEqual({
      archivedAt: expect.any(String),
      subscribed: true,
    });
    await expect(feedIds(first)).resolves.toEqual([]);
    expect((await setPin(second, id, true)).status).toBe(200);
    await expect(feedIds(first)).resolves.toEqual([id]);
    await expect(feedIds(second)).resolves.toEqual([id]);
  });
});
