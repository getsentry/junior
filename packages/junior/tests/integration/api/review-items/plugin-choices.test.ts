import {
  defineJuniorPlugin,
  type ReviewItemAnsweredHookContext,
  type User,
} from "@sentry/junior-plugin-api";
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
import { createPluginReviewItems } from "@/chat/review-items/plugin";
import { getReviewItem } from "@/chat/review-items/store";
import { getConversation } from "@/chat/task-execution/store";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";

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
      app.request(`http://localhost/api/review-items/${id}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    get: (id: string) => app.request(`http://localhost/api/review-items/${id}`),
  };
}

it("gives the answer to a plugin item's choice to the plugin, and starts no Turn", async () => {
  const answers: Array<
    Pick<
      ReviewItemAnsweredHookContext,
      "choice" | "conversationId" | "dedupeKey" | "itemId"
    >
  > = [];
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
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
          async reviewItemAnswered(ctx) {
            const { choice, conversationId, dedupeKey, itemId } = ctx;
            answers.push({ choice, conversationId, dedupeKey, itemId });
            // The plugin can watch again for the item's Conversation, such
            // as when the Watch that the work needs has expired.
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
  await createPluginReviewItems({
    conversationId: CONVERSATION_ID,
    plugin: "deploys",
    show: async () => {},
  }).upsert({
    assigneeIdentityIds: [ana.identityId],
    body: "Deploys of `api` stopped after 3 failures.",
    choices: [{ label: "Resume" }],
    dedupeKey: "deploy-stopped:api",
    title: "Deploys stopped · api",
  });

  // The choice is one button: an action that waits on Ana.
  const [row] = await getDb().query.juniorReviewItems.findMany();
  const shown = await (await api(fixture, ana.user).get(row!.id)).json();
  expect(shown).toMatchObject({
    canAct: true,
    kind: "action",
    request: {
      question: "Deploys of `api` stopped after 3 failures.",
      fields: [
        {
          id: "choice",
          kind: "choice",
          label: "Deploys stopped · api",
          options: [{ label: "Resume" }],
        },
      ],
    },
  });

  const response = await api(fixture, ana.user).act(row!.id, {
    action: "submit",
    answer: { values: { choice: ["Resume"] } },
  });
  expect(response.status).toBe(200);
  expect(answers).toEqual([
    {
      choice: "Resume",
      conversationId: CONVERSATION_ID,
      dedupeKey: "deploy-stopped:api",
      itemId: row!.id,
    },
  ]);
  expect(await getReviewItem(getDb(), row!.id)).toMatchObject({
    closedBy: { userId: ana.user.id },
    status: "done",
  });
  expect(await listWatches({ conversationId: CONVERSATION_ID })).toEqual([
    expect.objectContaining({
      events: ["deploy.stopped"],
      identifier: "api",
      namespace: "deploys",
    }),
  ]);
  // The plugin does the work, so the Conversation only records the answer.
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
  ).toHaveLength(1);
});
