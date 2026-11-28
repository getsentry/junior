import { sendVercelPluginTask } from "@/chat/plugins/task-queue";
import { createECDH, randomBytes, randomUUID, type ECDH } from "node:crypto";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createRequire } from "node:module";
import {
  createWebSource,
  type Identity,
  type User,
} from "@sentry/junior-plugin-api";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { createSlackActor } from "@/chat/actor";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createIdentityDispatcher } from "@/chat/agent-dispatch/identity";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import { upsertReplyNotice } from "@/chat/inbox-items/reply-notice";
import { getInboxItem } from "@/chat/inbox-items/store";
import { createAskUserQuestionTool } from "@/chat/questions/tools/ask-user-question";
import { ask } from "../fixtures/questions";
import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import {
  saveNotificationSchedule,
  savePushSubscription,
} from "@/chat/notifications/store";
import { syncInboxItemPush } from "@/chat/notifications/inbox-item-push";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createUpdateTodosTool } from "@/chat/todos/tools/update";
import {
  juniorConversationParticipants,
  juniorInboxItemDeliveries,
  juniorInboxItems,
} from "@/db/schema";
import { patchConfig, useConfig } from "../fixtures/config";
import { createConversationFixture } from "../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { useGitHubEvents } from "../fixtures/event-automations";
import { usersGetPresenceOk } from "../fixtures/slack/factories/api";
import {
  addEveryoneItem,
  addPullRequestItem,
  api,
  conversation,
  OTHER_PULL_REQUEST,
  PULL_REQUEST,
  ROOT,
  user,
} from "../fixtures/snoozes";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";
import { mswServer } from "../msw/server";
import {
  ownedPluginInboxItems,
  TEST_PLUGIN_INBOX_OWNER,
} from "../fixtures/plugin-inbox-owners";

// web-push encrypts with http_ece. The test reads the payload with it.
const ece = createRequire(createRequire(import.meta.url).resolve("web-push"))(
  "http_ece",
) as {
  decrypt(
    body: Buffer,
    params: { authSecret: Buffer; privateKey: ECDH; version: "aes128gcm" },
  ): Buffer;
};

const PUSH_URL = "https://fcm.googleapis.com/fcm/send/phone";
const queue = createConversationWorkQueueTestAdapter();
const services = createSlackInboxItemToolServices(() => queue);
const heartbeat = () =>
  runHeartbeat({
    sendPluginTask: sendVercelPluginTask,
    conversationWorkQueue: queue,
    dispatchForIdentity: createIdentityDispatcher({
      conversationWorkQueue: () => queue,
    }),
    events: createEventAppPublisher({ conversationWork: () => ({ queue }) }),
    nowMs: Date.now(),
    showInboxItem: services.show,
  });

// Parse the input first, as the agent runtime does.
async function execute(tool: any, input: unknown): Promise<any> {
  return await tool.execute(tool.prepareArguments(input), {} as any);
}

/** One phone of the user, with real P-256 keys, so the test can decrypt. */
const phone = (() => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { auth: randomBytes(16), ecdh };
})();

async function person(email: string): Promise<User> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  return user;
}

/** Ana has the phone, and pushes at any time. */
async function anaWithPhone(): Promise<User> {
  const ana = await person("ana@example.com");
  await addPhone(ana);
  return ana;
}

/** Give this User the phone, with pushes at any time. */
async function addPhone(ana: User): Promise<void> {
  await savePushSubscription(
    getDb(),
    ana.id,
    {
      endpoint: PUSH_URL,
      keys: {
        auth: phone.auth.toString("base64url"),
        p256dh: phone.ecdh.getPublicKey().toString("base64url"),
      },
    },
    Date.now(),
  );
  await saveNotificationSchedule(
    getDb(),
    ana.id,
    {
      days: [],
      end: "18:00",
      followSlack: false,
      start: "09:00",
      workingHoursOnly: false,
    },
    Date.now(),
  );
}

/** Tools of a Turn that Ana started, in the dashboard or a Slack thread. */
async function turnTools(
  ana: User,
  where: "dashboard" | "slack" = "dashboard",
  threadTs = "1.000001",
) {
  const conversationId =
    where === "slack" ? `slack:C1:${threadTs}` : `local:web:${randomUUID()}`;
  await getConversationStore().recordActivity({
    actor: { email: "ana@example.com" },
    conversationId,
    destination:
      where === "slack"
        ? {
            channelId: "C1",
            platform: "slack",
            teamId: "T123",
            threadTs,
          }
        : { platform: "local", conversationId },
    nowMs: Date.now(),
    source: where === "slack" ? "slack" : "web",
    visibility: "public",
  });
  const context = {
    conversationId,
    resolveActorIdentity: async () => ({
      identity: { id: `identity:${ana.id}` } as Identity,
      user: ana,
    }),
    source:
      where === "slack"
        ? ({ kind: "slack" } as any)
        : createWebSource(conversationId, "public"),
    turnId: "turn-1",
  };
  return {
    add: createAskUserQuestionTool(context, services),
    conversationId,
    update: createUpdateInboxItemTool(context, services),
  };
}

/** Detach a Conversation from its Slack thread, or attach it again, as Ana. */
async function setDelivery(
  ana: User,
  conversationId: string,
  paused: boolean,
): Promise<number> {
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(),
      rootConversationId: conversationId,
      userId: ana.id,
    })
    .onConflictDoNothing();
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", ana);
    await next();
  });
  app.route("/", createJuniorApi());
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/delivery`,
    {
      body: JSON.stringify({ paused }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  return response.status;
}

const ASK = {
  assignees: ["ana@example.com"],
  questions: [
    {
      question: "Approve the **deploy** of `api`?",
      header: "Decision",
      options: [
        { label: "Approve", description: "Deploy it now." },
        { label: "Reject", description: "Stop the deploy." },
      ],
    },
    {
      question: "Which regions get it first?",
      header: "Regions",
      multiSelect: true,
      options: [
        { label: "us", description: "Most traffic." },
        { label: "eu", description: "Least traffic." },
      ],
    },
  ],
};

describe("inbox item push", () => {
  let webPushConfig: { privateKey: string; publicKey: string; subject: string };
  let pushes: Record<string, unknown>[];

  beforeEach(async () => {
    const keys = webPush.generateVAPIDKeys();
    webPushConfig = {
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      subject: "mailto:junior@example.com",
    };
    useConfig({ webPush: webPushConfig });
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });
    await getStateAdapter().connect();
    pushes = [];
    mswServer.use(
      http.post(PUSH_URL, async ({ request }) => {
        const body = Buffer.from(await request.arrayBuffer());
        const plain = ece.decrypt(body, {
          authSecret: phone.auth,
          privateKey: phone.ecdh,
          version: "aes128gcm",
        });
        pushes.push(JSON.parse(plain.toString("utf8")));
        return new HttpResponse(null, { status: 201 });
      }),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    await closeDb();
  });

  it("pushes a new ask to its assignee once, and closes it with the next push", async () => {
    const ana = await anaWithPhone();
    const tools = await turnTools(ana);

    const added = await execute(tools.add, ASK);
    expect(pushes).toEqual([
      {
        body: "Approve the deploy of api? Which regions get it first?",
        tag: added.item.id,
        title: "Decision · Regions",
        url: `https://junior.example.com/inbox?item=${added.item.id}`,
      },
    ]);

    // A change of the same ask does not push again.
    await execute(tools.update, {
      id: added.item.id,
      questions: ask("Approve the deploy now?"),
    });
    // Everyone items and notices show only in the Inbox.
    const everyone = await execute(tools.add, {
      ...ASK,
      assignees: ["everyone"],
    });
    // Ana takes it, so she is its assignee now, but needs no push for it.
    await actOnInboxItem({
      action: "take",
      delivery: { queue, show: services.show },
      id: everyone.item.id,
      user: ana,
    });
    expect(pushes).toHaveLength(1);
    // An ask of one question shows it once, as the title.
    const single = await execute(tools.add, {
      assignees: ["ana@example.com"],
      questions: ask("Roll back the deploy?"),
    });
    expect(pushes[1]).toMatchObject({
      body: "",
      tag: single.item.id,
      title: "Roll back the deploy?",
    });
    // A question too long for the title shows only its cut title.
    const long = `Roll back the deploy? ${"It failed its canary checks. ".repeat(10)}`;
    const longAsk = await execute(tools.add, {
      assignees: ["ana@example.com"],
      questions: ask(long.trim()),
    });
    expect(pushes[2]).toMatchObject({
      body: "",
      tag: longAsk.item.id,
      title: expect.stringMatching(/…$/),
    });

    // Web Push cannot close a notification by itself. The next push tells
    // the phone to close the push of the ask that closed.
    await execute(tools.update, {
      id: added.item.id,
      status: "dismissed",
      reason: "Deploy rolled back",
    });
    expect(pushes).toHaveLength(3);
    // The close clears its deliveries in its own statement. If that failed,
    // the retry of the close shows the item again, and that clears them.
    await getDb()
      .update(juniorInboxItemDeliveries)
      .set({ status: "sent" })
      .where(eq(juniorInboxItemDeliveries.itemId, added.item.id));
    await syncInboxItemPush(added.item.id);
    const next = await execute(tools.add, ASK);
    expect(pushes[3]).toMatchObject({
      close: [added.item.id],
      tag: next.item.id,
    });
  });

  it("pushes a plugin item again on the same item when its ask changes", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          inboxSubjects: [
            { kind: "change", label: "Change", owner: TEST_PLUGIN_INBOX_OWNER },
          ],
          manifest: {
            description: "Review test plugin",
            displayName: "Reviews",
            name: "reviews",
          },
        }),
      ]),
    });
    // The app loads config again, without the web push keys or the dashboard
    // link, so install them again.
    useConfig({
      webPush: webPushConfig,
      dashboard: { baseURL: "https://junior.example.com" },
    });
    const ana = await anaWithPhone();
    const identityId = await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor("T123", "U0ANA", { email: "ana@example.com" }),
    );
    const { conversationId } = await turnTools(ana);
    const items = ownedPluginInboxItems({
      conversationId,
      plugin: "reviews",
      show: syncInboxItemPush,
    });
    const review = {
      askedIdentityIds: [identityId!],
      assigneeIdentityIds: [identityId!],
      body: "GitHub asks you to review #946.",
      subject: { id: "1001", kind: "change" },
      title: "Review requested · #946",
      waitsOnAssignees: true,
    };

    await items.upsert(review);
    const [item] = await getDb()
      .select({ id: juniorInboxItems.id })
      .from(juniorInboxItems);
    expect(pushes).toEqual([expect.objectContaining({ tag: item!.id })]);
    // New content of the same ask does not push again.
    await items.upsert({
      ...review,
      askedIdentityIds: [],
      body: "The review still waits.",
    });
    expect(pushes).toHaveLength(1);
    // The subject names the item, so the merge ask changes the same item,
    // and its snooze and pin stay. The event that gives the new ask pushes
    // again.
    await items.upsert({
      ...review,
      body: "#946 is approved. Merge it.",
      title: "#946 is approved…",
    });
    expect(pushes).toEqual([
      expect.objectContaining({ tag: item!.id }),
      // A title that ends in "…" but is not the cut body keeps the body.
      expect.objectContaining({
        body: "#946 is approved. Merge it.",
        tag: item!.id,
        title: "#946 is approved…",
      }),
    ]);
    expect(
      await getDb().select({ id: juniorInboxItems.id }).from(juniorInboxItems),
    ).toEqual([item]);

    // A wake of Ana's snooze pushed the item to her too.
    await getDb().insert(juniorInboxItemDeliveries).values({
      channel: "web_push",
      createdAt: new Date(),
      event: "wake",
      itemId: item!.id,
      status: "sent",
      updatedAt: new Date(),
      userId: ana.id,
    });

    // Ana leaves while Ben's ask keeps the item open. A new ask brings her
    // back, and it pushes to her again.
    const ben = await person("ben@example.com");
    await getDb().insert(juniorConversationParticipants).values({
      lastMessageAt: new Date(),
      rootConversationId: conversationId,
      userId: ben.id,
    });
    const benIdentityId = await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor("T123", "U0BEN", { email: "ben@example.com" }),
    );
    await items.upsert({
      ...review,
      askedIdentityIds: [benIdentityId!],
      assigneeIdentityIds: [benIdentityId!],
    });
    expect(pushes).toHaveLength(2);
    await items.upsert({
      ...review,
      assigneeIdentityIds: [identityId!, benIdentityId!],
      title: "Review requested again · #946",
    });
    expect(pushes.at(-1)).toEqual(
      expect.objectContaining({
        tag: item!.id,
        title: "Review requested again · #946",
      }),
    );
    // Her rejoin forgets every push of the item that her leave cleared, so
    // no later push closes it on her phone.
    expect(pushes.at(-1)).not.toHaveProperty("close");
  });

  it("pushes a To-do for a person to each new assignee once, and closes it when it moves on", async () => {
    const ana = await anaWithPhone();
    await user("bob@example.com");
    await conversation(ROOT, "public");
    const tool = createUpdateTodosTool(
      { conversationId: ROOT },
      services.findMentionedUserId,
    );
    const updateTodos = async (input: unknown) => await execute(tool, input);

    const {
      todos: [todo],
    } = await updateTodos({
      add: [
        { title: "Confirm the rollback window", assignee: "bob@example.com" },
      ],
    });
    expect(pushes).toEqual([]);
    // The item moves to Ana, so she gets its push.
    await updateTodos({
      update: [
        {
          id: todo.id,
          assignee: "ana@example.com",
          notes: "Check the **deploy** calendar.",
        },
      ],
    });
    const itemId = pushes[0]?.["tag"] as string;
    expect(pushes).toEqual([
      {
        body: "Check the deploy calendar.",
        tag: itemId,
        title: "Confirm the rollback window",
        url: `https://junior.example.com/inbox?item=${itemId}`,
      },
    ]);
    // A change of the same To-do does not push again.
    await updateTodos({
      update: [{ id: todo.id, title: "Confirm the rollback week" }],
    });
    expect(pushes).toHaveLength(1);

    // Ana can no longer see the item once it moves to Bob, so her next push
    // closes its push.
    await updateTodos({
      update: [{ id: todo.id, assignee: "bob@example.com" }],
    });
    expect(pushes).toHaveLength(1);
    const next = await execute((await turnTools(ana)).add, ASK);
    expect(pushes[1]).toMatchObject({ close: [itemId], tag: next.item.id });

    // When it comes back to Ana, it pushes to her again, and her later
    // pushes do not close it.
    await updateTodos({
      update: [{ id: todo.id, assignee: "ana@example.com" }],
    });
    expect(pushes[2]).toEqual({
      body: "Check the deploy calendar.",
      tag: itemId,
      title: "Confirm the rollback week",
      url: `https://junior.example.com/inbox?item=${itemId}`,
    });
    await execute((await turnTools(ana)).add, {
      ...ASK,
    });
    expect(pushes[3]?.["close"]).toBeUndefined();
  });

  it("pushes an item that Slack shows only to an assignee who is away in Slack 5 minutes later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ana = await anaWithPhone();
    await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor("T123", "U0ANA", { email: "ana@example.com" }),
    );
    const tools = await turnTools(ana, "slack");
    const later = async (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
      await heartbeat();
    };
    const webPushes = async (itemId: string) =>
      await getDb()
        .select({
          skipReason: juniorInboxItemDeliveries.skipReason,
          status: juniorInboxItemDeliveries.status,
        })
        .from(juniorInboxItemDeliveries)
        .where(
          and(
            eq(juniorInboxItemDeliveries.itemId, itemId),
            eq(juniorInboxItemDeliveries.channel, "web_push"),
          ),
        );

    // The card posts at once. The push waits, so Ana can answer in Slack.
    const away = await execute(tools.add, ASK);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    await later(4 * 60_000);
    expect(pushes).toEqual([]);
    expect(getCapturedSlackApiCalls("users.getPresence")).toEqual([]);

    // She is away in Slack, so the card did not reach her.
    await later(60_000);
    expect(getCapturedSlackApiCalls("users.getPresence")).toEqual([
      expect.objectContaining({ params: { user: "U0ANA" } }),
    ]);
    expect(pushes).toEqual([
      expect.objectContaining({
        tag: away.item.id,
        title: "Decision · Regions",
      }),
    ]);
    await later(5 * 60_000);
    expect(pushes).toHaveLength(1);

    // She is active in Slack, so Slack's own notification reached her.
    const active = await execute(tools.add, {
      ...ASK,
    });
    queueSlackApiResponse("users.getPresence", {
      body: usersGetPresenceOk("active"),
    });
    await later(5 * 60_000);
    expect(pushes).toHaveLength(1);
    expect(await webPushes(active.item.id)).toEqual([
      { skipReason: "slack_active", status: "skipped" },
    ]);

    // She dismisses the card before the wait ends, so nothing pushes.
    const dismissed = await execute(tools.add, {
      ...ASK,
    });
    await actOnInboxItem({
      action: "dismiss",
      delivery: { queue, show: services.show },
      id: dismissed.item.id,
      user: ana,
    });
    await later(5 * 60_000);
    expect(pushes).toHaveLength(1);
    expect(getCapturedSlackApiCalls("users.getPresence")).toHaveLength(2);
    expect(await webPushes(dismissed.item.id)).toEqual([]);

    // She is unassigned while her push waits, so the wait ends with no
    // push. Assigned again, she gets it at the next heartbeat.
    await person("bob@example.com");
    const reassigned = await execute(tools.add, ASK);
    await execute(tools.update, {
      id: reassigned.item.id,
      assignees: ["bob@example.com"],
    });
    await later(5 * 60_000);
    expect(pushes).toHaveLength(1);
    await execute(tools.update, {
      id: reassigned.item.id,
      assignees: ["ana@example.com"],
    });
    await later(60_000);
    expect(pushes).toEqual([
      expect.objectContaining({ tag: away.item.id }),
      expect.objectContaining({ tag: reassigned.item.id }),
    ]);
  });
  it("pushes an item that Slack shows at once when its Conversation detaches from or attaches to Slack", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const ana = await anaWithPhone();
    const first = await turnTools(ana, "slack");
    const second = await turnTools(ana, "slack", "2.000001");

    // The detach ends the wait of the card in its thread.
    const detached = await execute(first.add, ASK);
    expect(pushes).toEqual([]);
    expect(await setDelivery(ana, first.conversationId, true)).toBe(200);
    expect(pushes).toEqual([
      expect.objectContaining({ tag: detached.item.id }),
    ]);

    // The detached thread gets no card, so this item waits on the card in
    // the other thread, until the detached Conversation attaches again.
    const attached = await execute(second.add, ASK);
    await execute(second.update, {
      id: attached.item.id,
      conversation_ids: [first.conversationId],
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ thread_ts: "1.000001" }),
      }),
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({ thread_ts: "2.000001" }),
      }),
    ]);
    expect(pushes).toHaveLength(1);
    expect(await setDelivery(ana, first.conversationId, false)).toBe(200);
    expect(pushes).toEqual([
      expect.objectContaining({ tag: detached.item.id }),
      expect.objectContaining({ tag: attached.item.id }),
    ]);

    // The waits end without a presence check or a second push.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await heartbeat();
    expect(pushes).toHaveLength(2);
    expect(getCapturedSlackApiCalls("users.getPresence")).toEqual([]);
  });

  it("pushes each wake of a snooze from a time or an Event, once", async () => {
    // The app that GitHub Events need sets its own dashboard links.
    await useGitHubEvents();
    // The app loads config again, without the web push keys.
    useConfig({ webPush: webPushConfig });
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });
    const fixture = await createConversationFixture();
    // A User of the Slack workspace, so she can see the items of its thread.
    const ana = await user("ana@example.com");
    await addPhone(ana);
    await conversation(ROOT, "public");
    const asAna = api(fixture, ana);
    const publisher = createEventAppPublisher({
      conversationWork: () => ({ queue: fixture.queue }),
    });
    const heartbeat = (nowMs: number) =>
      runHeartbeat({
        sendPluginTask: sendVercelPluginTask,
        conversationWorkQueue: fixture.queue,
        dispatchForIdentity: createIdentityDispatcher({
          conversationWorkQueue: () => fixture.queue,
        }),
        events: publisher,
        nowMs,
      });
    const merged = {
      eventKey: `pull_request.merged:${PULL_REQUEST.identifier}`,
      eventType: "pull_request.merged",
      identifier: PULL_REQUEST.identifier,
      namespace: "github",
      occurredAtMs: Date.now(),
      trustedSummary: "Pull request merged.",
    };
    // The title says it all, so the push repeats no body.
    const wakePush = (id: string) => ({
      body: "",
      tag: id,
      title: "Review acme entry",
      url: `https://junior.example.com/inbox?item=${id}`,
    });
    const wakeDelivery = async (id: string) =>
      (
        await getDb()
          .select({
            skipReason: juniorInboxItemDeliveries.skipReason,
            status: juniorInboxItemDeliveries.status,
          })
          .from(juniorInboxItemDeliveries)
          .where(
            and(
              eq(juniorInboxItemDeliveries.itemId, id),
              eq(juniorInboxItemDeliveries.event, "wake"),
            ),
          )
      )[0];

    // The timer wakes it once. A later heartbeat finds nothing to wake.
    const acme = await addPullRequestItem(ROOT, [ana], "Review acme entry");
    const row = { conversationId: ROOT, inboxItemId: acme };
    const wakeAtMs = Date.now() + 60_000;
    expect((await asAna.snooze(row, wakeAtMs)).status).toBe(201);
    await heartbeat(wakeAtMs);
    await heartbeat(wakeAtMs + 1);
    expect(pushes).toEqual([wakePush(acme)]);
    expect(await wakeDelivery(acme)).toEqual({
      skipReason: null,
      status: "sent",
    });

    // The Event wakes it again, and its repeat wakes nothing.
    expect(
      (
        await asAna.snoozeOn(row, [
          { eventType: "pull_request.merged", outcome: "wake" },
        ])
      ).status,
    ).toBe(201);
    await publisher.publish(merged);
    await publisher.publish(merged);
    expect(pushes).toEqual([wakePush(acme), wakePush(acme)]);

    // The reply notice of her dashboard Conversation pushes to her too.
    const tools = await turnTools(ana);
    const notice = await upsertReplyNotice(getDb(), {
      body: "The deploy finished.",
      conversationId: tools.conversationId,
      nowMs: Date.now(),
      starterUserId: ana.id,
      title: "Deploy api",
      turnId: "turn-1",
    });
    expect(
      (
        await asAna.snooze(
          { conversationId: tools.conversationId, inboxItemId: notice },
          wakeAtMs + 30_000,
        )
      ).status,
    ).toBe(201);
    await heartbeat(wakeAtMs + 30_000);
    expect(pushes[2]).toEqual({
      body: "The deploy finished.",
      tag: notice,
      title: "Deploy api",
      url: `https://junior.example.com/conversations/${encodeURIComponent(tools.conversationId)}`,
    });

    // A Wake that she picks pushes nothing, and its timer then finds the
    // snooze woken.
    expect((await asAna.snooze(row, wakeAtMs + 60_000)).status).toBe(201);
    expect((await asAna.unsnooze(row)).status).toBe(204);
    await heartbeat(wakeAtMs + 60_000);
    // A trigger that resolves the item closes it and pushes nothing.
    // A subject names one open item, so it is about another pull request.
    const globex = await addPullRequestItem(
      ROOT,
      [ana],
      "Review globex entry",
      OTHER_PULL_REQUEST.url,
    );
    expect(
      (
        await asAna.snoozeOn({ conversationId: ROOT, inboxItemId: globex }, [
          { eventType: "pull_request.merged", outcome: "resolve" },
        ])
      ).status,
    ).toBe(201);
    await publisher.publish({
      ...merged,
      eventKey: `pull_request.merged:${OTHER_PULL_REQUEST.identifier}`,
      identifier: OTHER_PULL_REQUEST.identifier,
    });
    expect((await getInboxItem(getDb(), globex))?.status).toBe("dismissed");
    // An Everyone item does not push when its snooze wakes.
    const everyone = await addEveryoneItem(ROOT, "Review initech entry");
    expect(
      (
        await asAna.snooze(
          { conversationId: ROOT, inboxItemId: everyone },
          wakeAtMs + 120_000,
        )
      ).status,
    ).toBe(201);
    await heartbeat(wakeAtMs + 120_000);
    expect(pushes).toHaveLength(3);

    // Outside her notification hours, the wake is recorded as skipped.
    const hooli = await addPullRequestItem(
      ROOT,
      [ana],
      "Review hooli entry",
      OTHER_PULL_REQUEST.url,
    );
    await saveNotificationSchedule(
      getDb(),
      ana.id,
      {
        days: [],
        end: "18:00",
        followSlack: false,
        start: "09:00",
        workingHoursOnly: true,
      },
      Date.now(),
    );
    expect(
      (
        await asAna.snooze(
          { conversationId: ROOT, inboxItemId: hooli },
          wakeAtMs + 180_000,
        )
      ).status,
    ).toBe(201);
    await heartbeat(wakeAtMs + 180_000);
    expect(pushes).toHaveLength(3);
    expect(await wakeDelivery(hooli)).toEqual({
      skipReason: "outside_hours",
      status: "skipped",
    });

    // The close of a woken item clears its push on every device.
    expect((await asAna.act(acme, { action: "dismiss" })).status).toBe(200);
    expect(await wakeDelivery(acme)).toMatchObject({ status: "cleared" });
    await addPhone(ana);
    const next = await execute(tools.add, ASK);
    expect(pushes[3]).toMatchObject({ close: [acme], tag: next.item.id });

    // An item with both a created and a wake push closes once.
    const nextRow = {
      conversationId: tools.conversationId,
      inboxItemId: next.item.id,
    };
    expect((await asAna.snooze(nextRow, wakeAtMs + 240_000)).status).toBe(201);
    await heartbeat(wakeAtMs + 240_000);
    expect(pushes[4]).toMatchObject({ tag: next.item.id });
    expect((await asAna.act(next.item.id, { action: "dismiss" })).status).toBe(
      200,
    );
    await execute(tools.add, ASK);
    // Her dismiss in the Conversation also closes its reply notice.
    expect((await getInboxItem(getDb(), notice))?.status).toBe("done");
    expect(pushes[5]?.["close"]).toEqual(
      expect.arrayContaining([notice, next.item.id, acme]),
    );
    expect(pushes[5]?.["close"]).toHaveLength(3);
  });
});
