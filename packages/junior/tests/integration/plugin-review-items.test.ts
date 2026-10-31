import type { User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createPluginReviewItems } from "@/chat/review-items/plugin";
import {
  getOpenReviewItemByDedupeKey,
  getReviewItem,
} from "@/chat/review-items/store";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";

const TENANT = { provider: "slack", providerTenantId: "T123" };

async function conversation(
  conversationId: string,
  visibility: "public" | "private",
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "C1" },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility,
  });
}

/** Add a User with one Slack Identity, and return the Identity id. */
async function person(
  email: string,
): Promise<{ identityId: string; user: User }> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  const identityId = `identity:${email}`;
  await getDb()
    .insert(juniorIdentities)
    .values({
      createdAt: new Date(1),
      id: identityId,
      kind: "user",
      provider: "slack",
      providerSubjectId: email,
      providerTenantId: "T123",
      updatedAt: new Date(1),
      userId: user.id,
    });
  return { identityId, user };
}

const NOTICE = {
  body: "**Fix the thing** is approved and its checks pass.",
  dedupeKey: "pull-request-ready:getsentry/junior#946",
  subject: {
    id: "https://github.com/getsentry/junior/pull/946",
    title: "getsentry/junior#946",
    url: "https://github.com/getsentry/junior/pull/946",
  },
  title: "Ready to merge: getsentry/junior#946",
};

describe("plugin review items", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps one open notice per plugin key and closes it", async () => {
    await conversation("slack:C1:1.000001", "public");
    const ana = await person("ana@example.com");
    const items = createPluginReviewItems({
      conversationId: "slack:C1:1.000001",
      plugin: "github",
    });

    await items.upsert({ ...NOTICE, assigneeIdentityIds: [ana.identityId] });
    const added = await getOpenReviewItemByDedupeKey(
      getDb(),
      `github:${NOTICE.dedupeKey}`,
      TENANT,
    );
    expect(added).toMatchObject({
      addedByConversationId: "slack:C1:1.000001",
      assignees: [{ email: "ana@example.com", userId: ana.user.id }],
      conversationIds: ["slack:C1:1.000001"],
      kind: "notice",
      status: "open",
      subject: NOTICE.subject,
      title: NOTICE.title,
      visibility: "public",
    });

    // A repeat updates the open item.
    await items.upsert({
      ...NOTICE,
      assigneeIdentityIds: [ana.identityId],
      title: "Still ready to merge",
    });
    expect(
      await getOpenReviewItemByDedupeKey(
        getDb(),
        `github:${NOTICE.dedupeKey}`,
        TENANT,
      ),
    ).toMatchObject({ id: added!.id, title: "Still ready to merge" });

    await items.close({
      dedupeKey: NOTICE.dedupeKey,
      reason: "The pull request merged.",
      status: "done",
    });
    expect(await getReviewItem(getDb(), added!.id)).toMatchObject({
      closeReason: "The pull request merged.",
      status: "done",
    });
    // A close with no open item does nothing.
    await items.close({
      dedupeKey: NOTICE.dedupeKey,
      reason: "Again.",
      status: "dismissed",
    });
    expect(await getReviewItem(getDb(), added!.id)).toMatchObject({
      closeReason: "The pull request merged.",
    });

    // The key is scoped to the plugin, so another plugin has its own item.
    await createPluginReviewItems({
      conversationId: "slack:C1:1.000001",
      plugin: "linear",
    }).upsert({ ...NOTICE, assigneeIdentityIds: [] });
    expect(
      await getOpenReviewItemByDedupeKey(
        getDb(),
        `linear:${NOTICE.dedupeKey}`,
        TENANT,
      ),
    ).toMatchObject({ assignees: [], status: "open" });
  });

  it("assigns a private notice only to people in its Conversation", async () => {
    await conversation("slack:D1:1.000001", "private");
    const ana = await person("ana@example.com");
    const ben = await person("ben@example.com");
    await getDb()
      .insert(juniorConversationParticipants)
      .values({
        lastMessageAt: new Date(1),
        rootConversationId: "slack:D1:1.000001",
        userId: ana.user.id,
      });
    const items = createPluginReviewItems({
      conversationId: "slack:D1:1.000001",
      plugin: "github",
    });

    await expect(
      items.upsert({ ...NOTICE, assigneeIdentityIds: [ben.identityId] }),
    ).rejects.toThrow("only to people in its Conversation");
    await items.upsert({ ...NOTICE, assigneeIdentityIds: [ana.identityId] });
    expect(
      await getOpenReviewItemByDedupeKey(
        getDb(),
        `github:${NOTICE.dedupeKey}`,
        TENANT,
      ),
    ).toMatchObject({
      assignees: [{ userId: ana.user.id }],
      visibility: "private",
    });
  });
});
