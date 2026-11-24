import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import {
  defineJuniorPlugin,
  type ConversationAnnotationChange,
  type PluginRegistration,
  type User,
} from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createPluginInboxItems } from "@/chat/inbox-items/plugin";
import {
  createPluginAnnotations,
  listConversationAnnotations,
} from "@/chat/plugins/annotations";
import { createPluginConversationChanges } from "@/chat/plugins/conversation-changes";
import {
  actOnInboxItem,
  closeInboxItemsAnsweredByReply,
} from "@/chat/inbox-items/actions";
import {
  countInboxItemsNeedingUserBySubject,
  getOpenInboxItemBySubject,
  getInboxItem,
} from "@/chat/inbox-items/store";
import { listWaitingConversations } from "@/chat/inbox-items/waiting";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import {
  juniorConversationParticipants,
  juniorConversations,
  juniorIdentities,
  juniorInboxSnoozes,
} from "@/db/schema";
import { eq } from "drizzle-orm";

const TENANT = { provider: "slack", providerTenantId: "T123" };

const services = createSlackInboxItemToolServices(
  createConversationWorkQueueTestAdapter,
);

/** Item ids that plugin changes showed, in order. */
let shown: string[] = [];
const show = async (itemId: string) => {
  shown.push(itemId);
};

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

/** Add a User as a person in a root Conversation. */
async function participant(
  rootConversationId: string,
  user: User,
): Promise<void> {
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(1),
      rootConversationId,
      userId: user.id,
    });
}

const NOTICE = {
  body: "**Fix the thing** is approved, and GitHub says that it can merge. Merge it, or say why not.",
  subject: {
    id: "https://github.com/getsentry/junior/pull/946",
    kind: "ready",
  },
  title: "Ready to merge · #946",
};

/** A plugin that registers the `ready` subject kind. */
function readyPlugin(name: string): PluginRegistration {
  return defineJuniorPlugin({
    inboxSubjects: [{ kind: "ready", label: "Ready to merge" }],
    manifest: { description: `${name} test plugin`, displayName: name, name },
  });
}

describe("plugin inbox items", () => {
  beforeEach(async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        readyPlugin("github"),
        readyPlugin("linear"),
      ]),
    });
  });

  afterEach(async () => {
    shown = [];
    await closeDb();
  });

  it("waits on the assignee only when the plugin asks", async () => {
    await conversation("slack:C1:1.000001", "public");
    const ana = await person("ana@example.com");
    await participant("slack:C1:1.000001", ana.user);
    const items = createPluginInboxItems({
      conversationId: "slack:C1:1.000001",
      plugin: "github",
      show,
    });

    // A notice is for information: it does not wait on Ana.
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [ana.identityId],
      assigneeIdentityIds: [ana.identityId],
    });
    expect(await listWaitingConversations(getDb(), ana.user.id)).toEqual([]);

    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [ana.identityId],
      assigneeIdentityIds: [ana.identityId],
      waitsOnAssignees: true,
    });
    expect(
      await getOpenInboxItemBySubject(
        getDb(),
        { id: NOTICE.subject.id, kind: "github:ready" },
        TENANT,
      ),
    ).toMatchObject({ kind: "action", status: "open" });
    // The dashboard shows the plugin's mark next to the title.
    expect(await listWaitingConversations(getDb(), ana.user.id)).toEqual([
      {
        conversationId: "slack:C1:1.000001",
        items: [{ plugin: "github", title: NOTICE.title }],
        waitingSince: expect.any(String),
      },
    ]);
    expect(
      await countInboxItemsNeedingUserBySubject(getDb(), ana.user.id),
    ).toEqual([expect.objectContaining({ decisions: 0, total: 1 })]);

    // A reply cannot close it: the plugin closes it when the provider state
    // changes. No item can match, so the reply check stops early.
    let checkedReply = false;
    await closeInboxItemsAnsweredByReply({
      canAnswer: async () => {
        checkedReply = true;
        return false;
      },
      conversationId: "slack:C1:1.000001",
      delivery: {} as any,
      resolveUser: async () => ana.user,
      text: "Merged it, thanks.",
    });
    expect(checkedReply).toBe(false);
  });

  it("keeps one open notice per plugin key and closes it", async () => {
    await conversation("slack:C1:1.000001", "public");
    const ana = await person("ana@example.com");
    await participant("slack:C1:1.000001", ana.user);
    const items = createPluginInboxItems({
      conversationId: "slack:C1:1.000001",
      plugin: "github",
      show,
    });

    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [ana.identityId],
      assigneeIdentityIds: [ana.identityId],
    });
    const added = await getOpenInboxItemBySubject(
      getDb(),
      { id: NOTICE.subject.id, kind: "github:ready" },
      TENANT,
    );
    expect(added).toMatchObject({
      owner: { id: "slack:C1:1.000001", kind: "conversation" },
      assignees: [{ email: "ana@example.com", userId: ana.user.id }],
      conversationIds: ["slack:C1:1.000001"],
      kind: "notice",
      status: "open",
      subject: { id: NOTICE.subject.id, kind: "github:ready" },
      title: NOTICE.title,
      visibility: "public",
    });

    // A repeat updates the open item.
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [ana.identityId],
      assigneeIdentityIds: [ana.identityId],
      title: "Still ready to merge",
    });
    expect(
      await getOpenInboxItemBySubject(
        getDb(),
        { id: NOTICE.subject.id, kind: "github:ready" },
        TENANT,
      ),
    ).toMatchObject({ id: added!.id, title: "Still ready to merge" });

    // An agent in another public Conversation of the tenant cannot change
    // the plugin notice. Its own dedupe keys are in another namespace.
    await conversation("slack:C1:1.000002", "public");
    const agent = {
      conversationId: "slack:C1:1.000002",
      resolveActorIdentity: async () => ({
        identity: { id: ana.identityId } as any,
        user: ana.user,
      }),
      source: { kind: "slack" } as any,
    };
    await expect(
      createUpdateInboxItemTool(agent, services).execute!(
        { id: added!.id, reason: "Not needed.", status: "dismissed" } as any,
        {} as any,
      ),
    ).rejects.toThrow("Only the plugin or a person can change it");

    await expect(
      items.close({
        subject: NOTICE.subject,
        reason: "The pull request merged.",
        status: "done",
      }),
    ).resolves.toBe(true);
    expect(await getInboxItem(getDb(), added!.id)).toMatchObject({
      closeReason: "The pull request merged.",
      status: "done",
    });
    // A close with no open item does nothing.
    await expect(
      items.close({
        subject: NOTICE.subject,
        reason: "Again.",
        status: "dismissed",
      }),
    ).resolves.toBe(false);
    expect(await getInboxItem(getDb(), added!.id)).toMatchObject({
      closeReason: "The pull request merged.",
    });
    // The add, the update, and the close each show the item. The second
    // close changes nothing, so it shows nothing.
    expect(shown).toEqual([added!.id, added!.id, added!.id]);

    // The key is scoped to the plugin, so another plugin has its own item.
    await createPluginInboxItems({
      conversationId: "slack:C1:1.000001",
      plugin: "linear",
      show,
    }).upsert({ ...NOTICE, askedIdentityIds: [], assigneeIdentityIds: [] });
    expect(
      await getOpenInboxItemBySubject(
        getDb(),
        { id: NOTICE.subject.id, kind: "linear:ready" },
        TENANT,
      ),
    ).toMatchObject({ assignees: [], status: "open" });
  });

  it("keeps one item for the asks of several people, and a Dismiss takes off only that person", async () => {
    await conversation("slack:C1:1.000001", "public");
    const ana = await person("ana@example.com");
    const bo = await person("bo@example.com");
    await participant("slack:C1:1.000001", ana.user);
    await participant("slack:C1:1.000001", bo.user);
    const items = createPluginInboxItems({
      conversationId: "slack:C1:1.000001",
      plugin: "github",
      show,
    });
    const both = [ana.identityId, bo.identityId];
    const assignees = async () =>
      (
        await getOpenInboxItemBySubject(
          getDb(),
          { id: NOTICE.subject.id, kind: "github:ready" },
          TENANT,
        )
      )?.assignees.map((assignee) => assignee.userId) ?? [];

    // Only the person whom an event asks joins the item.
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [ana.identityId],
      assigneeIdentityIds: both,
    });
    expect(await assignees()).toEqual([ana.user.id]);
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [bo.identityId],
      assigneeIdentityIds: both,
    });
    expect((await assignees()).sort()).toEqual(
      [ana.user.id, bo.user.id].sort(),
    );
    const item = await getOpenInboxItemBySubject(
      getDb(),
      { id: NOTICE.subject.id, kind: "github:ready" },
      TENANT,
    );
    await getDb().insert(juniorInboxSnoozes).values({
      createdAt: new Date(),
      id: "snooze-bo",
      inboxItemId: item!.id,
      state: "snoozed",
      userId: bo.user.id,
    });

    // Bo's Dismiss takes off only Bo, and ends his snooze. Ana keeps it.
    const delivery = { queue: createConversationWorkQueueTestAdapter(), show };
    await actOnInboxItem({
      action: "dismiss",
      delivery,
      id: item!.id,
      user: bo.user,
    });
    expect(await assignees()).toEqual([ana.user.id]);
    expect(
      await getDb()
        .select({ state: juniorInboxSnoozes.state })
        .from(juniorInboxSnoozes),
    ).toEqual([{ state: "cancelled" }]);

    // Bo still has an ask, but he left, so he comes back only with a new
    // one.
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [],
      assigneeIdentityIds: both,
      title: "Still ready to merge",
    });
    expect(await assignees()).toEqual([ana.user.id]);

    // The last person's Dismiss closes the item.
    await actOnInboxItem({
      action: "dismiss",
      delivery,
      id: item!.id,
      user: ana.user,
    });
    expect(await getInboxItem(getDb(), item!.id)).toMatchObject({
      closedBy: { userId: ana.user.id },
      status: "dismissed",
    });
  });

  it("saves a chip and an item close together or not at all", async () => {
    const conversationId = "slack:C1:1.000001";
    await conversation(conversationId, "public");
    const items = createPluginInboxItems({
      conversationId,
      plugin: "github",
      show,
    });
    await items.upsert({
      ...NOTICE,
      askedIdentityIds: [],
      assigneeIdentityIds: [],
    });
    const chip = {
      key: "getsentry/junior#946",
      kind: "resource_link",
      label: "getsentry/junior#946",
      status: "open",
      url: "https://github.com/getsentry/junior/pull/946",
    } as const;
    await createPluginAnnotations({
      conversationId,
      db: getDb(),
      plugin: "github",
    }).upsert(chip);
    const item = await getOpenInboxItemBySubject(
      getDb(),
      { id: NOTICE.subject.id, kind: "github:ready" },
      TENANT,
    );
    const changes = createPluginConversationChanges({ plugin: "github", show });
    const detailVersion = async () =>
      (
        await getDb()
          .select({ version: juniorConversations.detailVersion })
          .from(juniorConversations)
          .where(eq(juniorConversations.conversationId, conversationId))
      )[0]?.version;
    const before = await detailVersion();
    const close = {
      subject: NOTICE.subject,
      reason: "The pull request merged.",
      status: "done",
    } as const;
    const annotation: ConversationAnnotationChange = {
      conversationId,
      upsert: { ...chip, status: "merged" },
    };
    const merged = {
      annotations: [annotation],
      inboxItems: [{ close, conversationId }],
    };

    // The close of an item in a missing Conversation fails, so the chip
    // stays open too, and no reader sees a change.
    await expect(
      changes.apply({
        ...merged,
        inboxItems: [
          ...merged.inboxItems,
          { close, conversationId: "slack:C1:9.000009" },
        ],
      }),
    ).rejects.toThrow("Conversation slack:C1:9.000009 is not found");
    expect(await listConversationAnnotations(getDb(), conversationId)).toEqual([
      expect.objectContaining({ status: "open" }),
    ]);
    expect(await getInboxItem(getDb(), item!.id)).toMatchObject({
      status: "open",
    });
    expect(await detailVersion()).toBe(before);

    // A batch over the limit saves nothing.
    await expect(
      changes.apply({
        annotations: Array.from({ length: 101 }, () => annotation),
      }),
    ).rejects.toThrow("more than the limit of 100");

    await changes.apply(merged);
    expect(await listConversationAnnotations(getDb(), conversationId)).toEqual([
      expect.objectContaining({ status: "merged" }),
    ]);
    expect(await getInboxItem(getDb(), item!.id)).toMatchObject({
      closeReason: "The pull request merged.",
      status: "done",
    });
    // The add and the close show the item. The failed batch shows nothing.
    expect(shown).toEqual([item!.id, item!.id]);
  });

  it.each(["public", "private"] as const)(
    "assigns a %s notice only to people in its Conversation",
    async (visibility) => {
      await conversation("slack:D1:1.000001", visibility);
      const ana = await person("ana@example.com");
      const ben = await person("ben@example.com");
      await participant("slack:D1:1.000001", ana.user);
      const items = createPluginInboxItems({
        conversationId: "slack:D1:1.000001",
        plugin: "github",
        show,
      });

      // Ben is not in the Conversation, so the notice leaves him out.
      await items.upsert({
        ...NOTICE,
        askedIdentityIds: [ben.identityId, ana.identityId],
        assigneeIdentityIds: [ben.identityId, ana.identityId],
      });
      expect(
        await getOpenInboxItemBySubject(
          getDb(),
          { id: NOTICE.subject.id, kind: "github:ready" },
          TENANT,
        ),
      ).toMatchObject({
        assignees: [{ userId: ana.user.id }],
        visibility,
      });
    },
  );
});
