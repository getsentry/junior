import {
  defineJuniorPlugin,
  type InboxItemActionHookContext,
  type User,
} from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { listWatches } from "@/chat/events/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { getInboxItem } from "@/chat/inbox-items/store";
import { getConversation } from "@/chat/task-execution/store";
import {
  juniorConversationParticipants,
  juniorIdentities,
  juniorInboxItems,
} from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  ownedPluginInboxItems,
  TEST_PLUGIN_INBOX_OWNER,
} from "../../../fixtures/plugin-inbox-owners";

const CONVERSATION_ID = "slack:CPUB:1.000001";

afterEach(async () => {
  await closeConversationFixture();
});

/** A person in the Conversation, with a Slack Identity in workspace T123. */
async function person(
  email: string,
): Promise<{ identityId: string; user: User }> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  const identity = {
    id: `identity:slack:${email}`,
    provider: "slack",
    providerSubjectId: `U-${email}`,
    providerTenantId: "T123",
  };
  await getDb()
    .insert(juniorIdentities)
    .values({
      ...identity,
      createdAt: new Date(1),
      kind: "user",
      updatedAt: new Date(1),
      userId: user.id,
    });
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(1),
      rootConversationId: CONVERSATION_ID,
      userId: user.id,
    });
  return { identityId: identity.id, user: { ...user, identities: [identity] } };
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return {
    act: (id: string, body: unknown) =>
      app.request(`http://localhost/api/inbox-items/${id}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    get: (id: string) => app.request(`http://localhost/api/inbox-items/${id}`),
  };
}

it("gives a kind action on a plugin item to the plugin, and starts no Turn", async () => {
  const actions: Array<
    Pick<
      InboxItemActionHookContext,
      "action" | "conversationId" | "itemId" | "subject"
    >
  > = [];
  const watching: boolean[] = [];
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        inboxSubjects: [
          {
            actions: [{ icon: "wrench", id: "resume", label: "Keep fixing" }],
            kind: "deploy_stopped",
            label: "Deploys stopped",
            owner: TEST_PLUGIN_INBOX_OWNER,
          },
        ],
        manifest: {
          name: "deploys",
          displayName: "Deploys",
          description: "Deploy test plugin",
        },
        events: {
          resourceTypes: [
            { type: "service", supportedEvents: ["deploy.stopped"] },
          ],
          events: { "deploy.stopped": { reach: "resource" } },
        },
        hooks: {
          async inboxItemAction(ctx) {
            const { action, conversationId, itemId, subject } = ctx;
            actions.push({ action, conversationId, itemId, subject });
            // The plugin can watch again for the item's Conversation, such
            // as when the Watch that the work needs has expired.
            const watch = { eventType: "deploy.stopped", identifier: "api" };
            watching.push(await ctx.watches.watching(watch));
            await ctx.watches.subscribe({
              events: ["deploy.stopped"],
              intent: "Fix the deploys of api when they stop.",
              resource: {
                identifier: "api",
                label: "Service api",
                namespace: "deploys",
                supported_events: ["deploy.stopped"],
                type: "service",
              },
            });
            watching.push(await ctx.watches.watching(watch));
          },
        },
      }),
    ]),
  });
  const fixture = await createConversationFixture();
  await getConversationStore().recordActivity({
    conversationId: CONVERSATION_ID,
    destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility: "public",
  });
  const ana = await person("ana@example.com");
  const items = ownedPluginInboxItems({
    conversationId: CONVERSATION_ID,
    plugin: "deploys",
    show: async () => {},
  });
  const notice = {
    askedIdentityIds: [ana.identityId],
    assigneeIdentityIds: [ana.identityId],
    body: "Deploys of `api` stopped after 3 failures.",
    subject: { id: "api", kind: "deploy_stopped" },
    title: "Deploys stopped · api",
  };
  await items.upsert(notice);

  // The kind's action is a button: the item waits on Ana and asks nothing.
  const [row] = await getDb().select().from(juniorInboxItems);
  const shown = await (await api(fixture, ana.user).get(row!.id)).json();
  expect(shown).toMatchObject({
    canAct: true,
    kind: "action",
    subject: {
      actions: [{ icon: "wrench", id: "resume", label: "Keep fixing" }],
    },
  });
  expect(shown.request).toBeUndefined();
  expect(
    (await api(fixture, ana.user).act(row!.id, { action: "done" })).status,
  ).toBe(400);

  const response = await api(fixture, ana.user).act(row!.id, {
    action: "done",
    id: "resume",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    closeAction: "Keep fixing",
    status: "done",
  });
  expect(actions).toEqual([
    {
      action: "resume",
      conversationId: CONVERSATION_ID,
      itemId: row!.id,
      subject: { id: "api", kind: "deploy_stopped" },
    },
  ]);
  expect(await getInboxItem(getDb(), row!.id)).toMatchObject({
    closeAction: "resume",
    closedBy: { userId: ana.user.id },
    status: "done",
  });
  expect(watching).toEqual([false, true]);
  // A retry of the same action calls the plugin again.
  await api(fixture, ana.user).act(row!.id, { action: "done", id: "resume" });
  expect(actions).toHaveLength(2);

  // An item from before kinds had actions asks with a choice. Its pick
  // runs the action that the old label names by id, and its history reads
  // the same.
  await items.upsert(notice);
  const [legacy] = await getDb()
    .select()
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.status, "open"));
  await getDb()
    .update(juniorInboxItems)
    .set({
      request: {
        question: notice.body,
        fields: [
          {
            id: "choice",
            kind: "choice",
            label: notice.title,
            options: [{ label: "Resume" }],
          },
        ],
      },
    })
    .where(eq(juniorInboxItems.id, legacy!.id));
  await api(fixture, ana.user).act(legacy!.id, {
    action: "submit",
    answer: { values: { choice: ["Resume"] } },
  });
  expect(actions.at(-1)).toMatchObject({
    action: "resume",
    itemId: legacy!.id,
  });

  // The item history keeps each Resume, also after a new ask opens, so the
  // plugin keeps no record of what Ana did.
  await items.upsert(notice);
  const [asked] = await getDb()
    .select()
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.status, "open"));
  expect(await items.history(notice.subject)).toEqual([
    { id: asked!.id, status: "open" },
    {
      action: "resume",
      closedAtMs: expect.any(Number),
      id: legacy!.id,
      status: "done",
    },
    {
      action: "resume",
      closedAtMs: expect.any(Number),
      id: row!.id,
      status: "done",
    },
  ]);
  expect(await listWatches({ conversationId: CONVERSATION_ID })).toEqual([
    expect.objectContaining({
      events: ["deploy.stopped"],
      identifier: "api",
      namespace: "deploys",
      // The Watch serves the person who answered (`follows-instruction`).
      creator: {
        actor: { platform: "web", email: ana.user.email, userId: ana.user.id },
        plugin: "deploys",
      },
    }),
  ]);
  // The plugin does the work, so the Conversation only records the actions.
  const conversation = await getConversation({
    conversationId: CONVERSATION_ID,
  });
  expect(conversation?.execution.pendingMessages ?? []).toEqual([]);
  const messages = projectConversationMessages(
    await getConversationEventStore().loadMessageHistory(CONVERSATION_ID),
  );
  expect(
    messages.filter((message) =>
      message.meta?.reviewItemChanges?.some(
        (change) => change.kind === "submitted",
      ),
    ),
  ).toHaveLength(2);
});

it("rejects a kind action icon that the dashboard does not have", () => {
  expect(() =>
    defineJuniorPlugin({
      inboxSubjects: [
        {
          actions: [
            // @ts-expect-error An untyped plugin can pass any icon.
            { icon: "rocket", id: "resume", label: "Keep fixing" },
          ],
          kind: "deploy_stopped",
          label: "Deploys stopped",
          owner: TEST_PLUGIN_INBOX_OWNER,
        },
      ],
      manifest: {
        name: "deploys",
        displayName: "Deploys",
        description: "Deploy test plugin",
      },
    }),
  ).toThrow(/icons from wrench/);
});
