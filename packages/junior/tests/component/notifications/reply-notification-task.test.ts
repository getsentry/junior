import { createECDH, randomBytes, randomUUID, type ECDH } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventSource,
  createWebSource,
  type Source,
} from "@sentry/junior-plugin-api";
import {
  createJuniorApi,
  resolveViewerUser,
  type JuniorApiVariables,
} from "@/api";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { notificationSettingsSchema } from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { createSlackActor } from "@/chat/actor";
import { CONVERSATION_METADATA_TASK } from "@/chat/conversations/metadata/task";
import { webActorFromUser } from "@/chat/conversations/web-input";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { recordConversationParticipant } from "@/chat/conversations/sql/participants";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import type { PiMessage } from "@/chat/pi/messages";
import {
  processPluginTask,
  scheduleSessionCompletedPluginTasks,
} from "@/chat/plugins/task-runner";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { upsertTurnRecord } from "@/chat/task-execution/turn-cursor";
import { getInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { juniorInboxItems } from "@/db/schema";
import { createConversationWorkQueueTestAdapter } from "../../fixtures/conversation-work";
import { dndInfoOk } from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";

const EMAIL = "alice@example.com";
const PUSH_ORIGIN = "https://fcm.googleapis.com/fcm/send";
const ENV_NAMES = [
  "JUNIOR_WEB_PUSH_PUBLIC_KEY",
  "JUNIOR_WEB_PUSH_PRIVATE_KEY",
  "JUNIOR_WEB_PUSH_SUBJECT",
] as const;

/** A browser subscription with real P-256 keys, so Web Push can encrypt. */
function browserSubscription(device: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `${PUSH_ORIGIN}/${device}`,
    expirationTime: null,
    keys: {
      auth: randomBytes(16).toString("base64url"),
      p256dh: ecdh.getPublicKey().toString("base64url"),
    },
  };
}

// web-push encrypts with http_ece. The test reads the payload with it.
const ece = createRequire(createRequire(import.meta.url).resolve("web-push"))(
  "http_ece",
) as {
  decrypt(
    body: Buffer,
    params: { authSecret: Buffer; privateKey: ECDH; version: "aes128gcm" },
  ): Buffer;
};

/** The Junior API as the signed-in dashboard user. */
async function viewerApp() {
  const viewer = await resolveViewerUser(EMAIL);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

/** The Conversation routes as the viewer, with a test work queue. */
async function viewerMessagesApp() {
  const viewer = await resolveViewerUser(EMAIL);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer!);
    await next();
  });
  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: createMemoryAttachmentStorage(),
      queue: createConversationWorkQueueTestAdapter(),
      waitUntil: () => undefined,
    }),
  );
  return app;
}

/** Post a message as the viewer, as the dashboard composer does. */
async function postFollowUp(conversationId: string, idempotencyKey: string) {
  const response = await (
    await viewerMessagesApp()
  ).request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ idempotencyKey, message: "Why?" }),
      headers: { "content-type": "application/json" },
    },
  );
  expect(response.status).toBe(200);
}

/** Report the viewer's read position, as the dashboard does. */
async function readConversation(conversationId: string, lastReadSeq: number) {
  const app = await viewerApp();
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/read-position`,
    {
      method: "PUT",
      body: JSON.stringify({ lastReadSeq }),
      headers: { "content-type": "application/json" },
    },
  );
  expect(response.status).toBe(200);
}

/** The reply notices of one Conversation, oldest first. */
async function replyNotices(conversationId: string) {
  const rows = await getDb()
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(eq(juniorInboxItems.dedupeKey, `reply:${conversationId}`))
    .orderBy(juniorInboxItems.createdAt);
  return await Promise.all(rows.map((row) => getInboxItem(getDb(), row.id)));
}

/** Add an open question for the starter, as the agent's card does. */
async function addQuestion(conversationId: string, userId: string) {
  const item = await insertInboxItem(getDb(), {
    assignedToEveryone: false,
    assigneeUserIds: [userId],
    body: "",
    conversationIds: [conversationId],
    dedupeKey: `question:${randomUUID()}`,
    kind: "action",
    nowMs: Date.now(),
    owner: { id: conversationId, kind: "conversation" },
    request: {
      question: "Roll back?",
      fields: [
        {
          id: "decision",
          kind: "choice",
          label: "Decision",
          options: [{ label: "Yes" }, { label: "No" }],
        },
      ],
    },
    title: "Roll back?",
    visibility: "private",
  });
  return item!.id;
}

/** Act on one Inbox item as the viewer, as the Inbox does. */
async function actOnItem(id: string, action: "dismiss") {
  const viewer = await resolveViewerUser(EMAIL);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route(
    "/",
    createJuniorApi({
      conversationWorkQueue: createConversationWorkQueueTestAdapter(),
    }),
  );
  const response = await app.request(
    `http://localhost/api/inbox-items/${id}/actions`,
    {
      method: "POST",
      body: JSON.stringify({ action }),
      headers: { "content-type": "application/json" },
    },
  );
  expect(response.status).toBe(200);
}

/** Call the notification API as the signed-in dashboard user. */
async function viewerApi() {
  const app = await viewerApp();
  return async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await app.request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? undefined
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    expect(response.status).toBe(status);
    if (status !== 200) return undefined;
    return notificationSettingsSchema.parse(await response.json());
  };
}

/**
 * Store one completed dashboard Turn and run the tasks it schedules. `reply`
 * is the raw model text. `stored` is the Message that the Turn saved; a
 * no-reply Turn saves none.
 */
async function completeDashboardTurn(
  reply: string,
  stored: { text: string } | null = { text: reply },
  {
    beforeTasks,
    conversationId = `local:web:${randomUUID()}`,
    earlierReplies = [],
    turnSource,
    turnId = "turn-1",
  }: {
    /** Runs after the reply is stored, before its tasks run. */
    beforeTasks?: (conversationId: string) => Promise<void>;
    conversationId?: string;
    earlierReplies?: string[];
    /** What started the Turn. Unset is the starter's dashboard message. */
    turnSource?: Source;
    turnId?: string;
  } = {},
): Promise<string[]> {
  const source = createWebSource(conversationId, "private");
  const destination = { platform: "local" as const, conversationId };
  await getConversationStore().recordActivity({
    conversationId,
    destination,
    nowMs: Date.now(),
    sessionSource: source,
    source: "web",
    title: "Deploy status",
    visibility: "private",
  });
  const user = await resolveViewerUser(EMAIL);
  if (!user) throw new Error("Test user was not created");
  await upsertTurnRecord({
    actor: webActorFromUser({ ...user, displayName: "Alice Example" }),
    conversationId,
    destination,
    // A later Turn's history holds the Turns before it.
    piMessages: [...earlierReplies, reply].flatMap((text, index) => [
      {
        role: "user",
        content: "Is the deploy done?",
        timestamp: 2 * index + 1,
      },
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        usage: {},
        stopReason: "stop",
        content: [{ type: "text", text }],
        timestamp: 2 * index + 2,
      },
    ]) as PiMessage[],
    sliceId: 1,
    source: turnSource ?? source,
    state: "completed",
    surface: "internal",
    turnId,
  });
  if (stored) {
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: Date.now(),
        data: {
          type: "message",
          messageId: `${turnId}:assistant:1`,
          role: "assistant",
          text: stored.text,
        },
      },
    ]);
  }
  await beforeTasks?.(conversationId);
  const scheduled: string[] = [];
  await scheduleSessionCompletedPluginTasks(
    { conversationId, sessionId: turnId },
    async (message) => {
      // The Conversation metadata task is out of scope here.
      if (message.plugin === CONVERSATION_METADATA_TASK.plugin) return;
      scheduled.push(`${message.plugin}.${message.name}`);
      await processPluginTask(message);
    },
  );
  return scheduled;
}

describe("reply notification task", () => {
  const savedEnv = new Map<string, string | undefined>();
  let previousLinks: ReturnType<typeof setDashboardConversationLinkOptions>;
  let pushes: Request[];

  beforeEach(async () => {
    for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
    const keys = webPush.generateVAPIDKeys();
    process.env["JUNIOR_WEB_PUSH_PUBLIC_KEY"] = keys.publicKey;
    process.env["JUNIOR_WEB_PUSH_PRIVATE_KEY"] = keys.privateKey;
    process.env["JUNIOR_WEB_PUSH_SUBJECT"] = "mailto:junior@example.com";
    previousLinks = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    await getStateAdapter().connect();
    pushes = [];
    mswServer.use(
      http.post(`${PUSH_ORIGIN}/phone`, ({ request }) => {
        pushes.push(request);
        return new HttpResponse(null, { status: 201 });
      }),
      http.post(
        `${PUSH_ORIGIN}/old-laptop`,
        () => new HttpResponse(null, { status: 410 }),
      ),
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setDashboardConversationLinkOptions(previousLinks);
    await disconnectStateAdapter();
    await closeDb();
  });

  it("pushes a dashboard reply inside working hours and removes a gone device", async () => {
    const api = await viewerApi();
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const before = await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("old-laptop"),
    );
    expect(before?.deviceCount).toBe(2);
    await api(
      "POST",
      "/api/notifications/subscriptions",
      {
        ...browserSubscription("phone"),
        endpoint: "https://169.254.169.254/latest/meta-data",
      },
      400,
    );
    await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    });

    await expect(
      completeDashboardTurn("The deploy finished."),
    ).resolves.toEqual([
      "event-search.indexEvents",
      "memory.processSession",
      "notifications.notifyReply",
    ]);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(pushes[0]!.headers.get("ttl")).toBe("43200");
    expect(pushes[0]!.headers.get("authorization")).toMatch(/^vapid /);
    const after = await api("GET", "/api/notifications");
    expect(after?.deviceCount).toBe(1);

    // A Turn with no reply notifies nobody.
    await completeDashboardTurn("Nothing to send.", null);
    expect(pushes).toHaveLength(1);
  });

  it("turns dashboard replies into one notice for the starter, and closes it when they read the latest", async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const decrypted: Record<string, unknown>[] = [];
    mswServer.use(
      http.post(`${PUSH_ORIGIN}/keyed-phone`, async ({ request }) => {
        const body = Buffer.from(await request.arrayBuffer());
        const plain = ece.decrypt(body, {
          authSecret: auth,
          privateKey: ecdh,
          version: "aes128gcm",
        });
        decrypted.push(JSON.parse(plain.toString("utf8")));
        return new HttpResponse(null, { status: 201 });
      }),
    );
    const api = await viewerApi();
    await api("POST", "/api/notifications/subscriptions", {
      endpoint: `${PUSH_ORIGIN}/keyed-phone`,
      expirationTime: null,
      keys: {
        auth: auth.toString("base64url"),
        p256dh: ecdh.getPublicKey().toString("base64url"),
      },
    });
    await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    });
    const user = await resolveViewerUser(EMAIL);
    const conversationId = `local:web:${randomUUID()}`;

    await completeDashboardTurn("The deploy started.", undefined, {
      conversationId,
    });
    // The starter takes part in the private Conversation, so they can read it.
    await recordConversationParticipant(getSqlExecutor(), {
      actorIdentityId: (await resolveActorIdentityId(
        getSqlExecutor(),
        webActorFromUser({ ...user!, displayName: "Alice Example" }),
      ))!,
      atMs: Date.now(),
      conversationId,
    });
    const [notice] = await replyNotices(conversationId);
    expect(notice).toMatchObject({
      assignees: [expect.objectContaining({ userId: user!.id })],
      body: "The deploy started.",
      kind: "notice",
      status: "open",
      title: "Deploy status",
    });
    // The dashboard reads the full reply from the notice's Turn.
    const read = await (
      await viewerApp()
    ).request(`http://localhost/api/inbox-items/${notice!.id}`);
    expect(await read.json()).toMatchObject({
      addedByTurnId: expect.any(String),
      replyNotice: true,
    });
    expect(decrypted).toEqual([
      {
        body: "The deploy started.",
        tag: notice!.id,
        title: "Deploy status",
        url: expect.stringContaining(encodeURIComponent(conversationId)),
      },
    ]);

    // The next reply replaces the notice's content and pushes again.
    await completeDashboardTurn("The deploy finished.", undefined, {
      conversationId,
      earlierReplies: ["The deploy started."],
      turnId: "turn-2",
    });
    expect(await replyNotices(conversationId)).toEqual([
      expect.objectContaining({
        body: "The deploy finished.",
        id: notice!.id,
        status: "open",
      }),
    ]);
    expect(decrypted[1]).toMatchObject({
      body: "The deploy finished.",
      tag: notice!.id,
    });

    // A read that stops before the latest reply leaves the notice open.
    await readConversation(conversationId, 0);
    expect((await replyNotices(conversationId))[0]?.status).toBe("open");
    await readConversation(conversationId, Number.MAX_SAFE_INTEGER);
    expect((await replyNotices(conversationId))[0]).toMatchObject({
      closeReason: "Read",
      status: "done",
    });

    // A reply after the read is a new notice. Its push closes the old one.
    await completeDashboardTurn("The deploy rolled back.", undefined, {
      conversationId,
      earlierReplies: ["The deploy started.", "The deploy finished."],
      turnId: "turn-3",
    });
    const notices = await replyNotices(conversationId);
    expect(notices.map((item) => item?.status)).toEqual(["done", "open"]);
    expect(decrypted[2]).toMatchObject({
      close: [notice!.id],
      tag: notices[1]!.id,
    });

    // A follow-up from the starter means they saw the reply.
    await postFollowUp(conversationId, "follow-up");
    expect((await replyNotices(conversationId))[1]?.status).toBe("done");

    // A starter who reads the reply before its task runs gets no notice and
    // no push.
    await completeDashboardTurn("A bad migration.", undefined, {
      beforeTasks: (id) => readConversation(id, Number.MAX_SAFE_INTEGER),
      conversationId,
      earlierReplies: [
        "The deploy started.",
        "The deploy finished.",
        "The deploy rolled back.",
      ],
      turnId: "turn-4",
    });
    expect(
      (await replyNotices(conversationId)).map((item) => item?.status),
    ).toEqual(["done", "done"]);
    expect(decrypted).toHaveLength(3);

    // A follow-up that waits as pending, with no event yet, still means the
    // starter saw the reply.
    await completeDashboardTurn("It ran twice.", undefined, {
      beforeTasks: (id) => postFollowUp(id, "follow-up-2"),
      conversationId,
      earlierReplies: [
        "The deploy started.",
        "The deploy finished.",
        "The deploy rolled back.",
        "A bad migration.",
      ],
      turnId: "turn-5",
    });
    expect(
      (await replyNotices(conversationId)).map((item) => item?.status),
    ).toEqual(["done", "done"]);
    expect(decrypted).toHaveLength(3);
  });

  it("adds no reply notice when an item waits on the starter or a provider Event started the Turn, and closes it when they act on an item", async () => {
    const api = await viewerApi();
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    });
    const user = await resolveViewerUser(EMAIL);
    const conversationId = `local:web:${randomUUID()}`;
    const replies: string[] = [];
    const turn = async (reply: string, turnSource?: Source): Promise<void> => {
      await completeDashboardTurn(reply, undefined, {
        conversationId,
        earlierReplies: [...replies],
        turnId: `turn-${replies.length + 1}`,
        ...(turnSource ? { turnSource } : undefined),
      });
      replies.push(reply);
    };

    await turn("The deploy started.");
    const [notice] = await replyNotices(conversationId);
    expect(notice?.status).toBe("open");
    expect(pushes).toHaveLength(1);

    // A provider Event's Turn, such as a review on the pull request, keeps
    // the notice as it was and pushes nothing.
    await turn(
      "The review asks for a test.",
      createEventSource({
        eventKey: "review-1",
        eventType: "pull_request.review.commented",
        identifier: "getsentry/junior#1",
        namespace: "github",
      }),
    );
    expect(await replyNotices(conversationId)).toEqual([
      expect.objectContaining({
        body: "The deploy started.",
        id: notice!.id,
        status: "open",
      }),
    ]);
    expect(pushes).toHaveLength(1);

    // A child agent's update is a core Event. Its reply can be the result
    // that the starter waits for, so it updates the notice and pushes.
    await turn(
      "The child agent finished the fix.",
      createEventSource({
        eventKey: "update-1",
        eventType: "agent.update",
        identifier: "local:web:child",
        namespace: "junior",
      }),
    );
    expect(await replyNotices(conversationId)).toEqual([
      expect.objectContaining({
        body: "The child agent finished the fix.",
        id: notice!.id,
        status: "open",
      }),
    ]);
    expect(pushes).toHaveLength(2);

    // The starter's dismiss of an item in the Conversation closes the notice.
    await actOnItem(await addQuestion(conversationId, user!.id), "dismiss");
    expect((await replyNotices(conversationId))[0]).toMatchObject({
      closeReason: "Item handled",
      status: "done",
    });

    await turn("The deploy finished.");
    const [, second] = await replyNotices(conversationId);
    expect(second?.status).toBe("open");
    expect(pushes).toHaveLength(3);

    // A reply while a question waits on the starter adds no notice and no
    // push, and closes the open notice: the question has their attention.
    await addQuestion(conversationId, user!.id);
    await turn("Should I roll back?");
    expect(
      (await replyNotices(conversationId)).map((item) => [
        item?.status,
        item?.closeReason,
      ]),
    ).toEqual([
      ["done", "Item handled"],
      ["done", "Item waits on you"],
    ]);
    expect(pushes).toHaveLength(3);
  });

  it("does not push outside the user's working hours", async () => {
    const api = await viewerApi();
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const hour = new Date().getUTCHours();
    const clock = (offset: number) =>
      `${String((hour + offset) % 24).padStart(2, "0")}:00`;
    const settings = await api("PUT", "/api/notifications/schedule", {
      workingHoursOnly: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: clock(2),
      end: clock(3),
      timezone: "UTC",
    });
    expect(settings).toMatchObject({
      timezone: "UTC",
      timezoneSource: "manual",
    });

    await completeDashboardTurn("Done while you were away.");

    expect(pushes).toHaveLength(0);
  });

  it("follows the linked Slack notification schedule by default and falls back to the hours", async () => {
    // Slack answers are cached per user for one minute, so each step below
    // starts in a new minute.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    const nextMinute = () => vi.setSystemTime(Date.now() + 60_000);
    const api = await viewerApi();
    await resolveActorIdentityId(
      getSqlExecutor(),
      createSlackActor("T123", "U0ALICE", { email: EMAIL }),
    );
    await api(
      "POST",
      "/api/notifications/subscriptions",
      browserSubscription("phone"),
    );
    const hour = new Date().getUTCHours();
    const clock = (offset: number) =>
      `${String((hour + offset) % 24).padStart(2, "0")}:00`;
    // A schedule without `followSlack` follows Slack.
    const anyTime = {
      workingHoursOnly: false,
      days: [],
      start: "09:00",
      end: "18:00",
    };
    const settings = await api("PUT", "/api/notifications/schedule", anyTime);
    expect(settings?.slackPausedNow).toBe(false);
    await completeDashboardTurn("Slack says you are around.");
    expect(pushes).toHaveLength(1);
    expect(getCapturedSlackApiCalls("dnd.info")).toEqual([
      expect.objectContaining({ params: { user: "U0ALICE" } }),
    ]);

    nextMinute();
    const nowMs = Date.now();
    queueSlackApiResponse("dnd.info", {
      body: dndInfoOk({ startMs: nowMs - 60_000, endMs: nowMs + 3_600_000 }),
    });
    await completeDashboardTurn("Slack is paused.");
    expect(pushes).toHaveLength(1);

    nextMinute();
    // Injected fault: the install has not granted `dnd:read` yet.
    queueSlackApiError("dnd.info", {
      error: "missing_scope",
      needed: "dnd:read",
    });
    await completeDashboardTurn("Slack cannot answer.");
    expect(pushes).toHaveLength(2);

    nextMinute();
    // Slack has no Do Not Disturb window, so it overrides the closed hours.
    const closedHours = {
      workingHoursOnly: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: clock(2),
      end: clock(3),
      timezone: "UTC",
    };
    await api("PUT", "/api/notifications/schedule", closedHours);
    await completeDashboardTurn("Slack says you are around again.");
    expect(pushes).toHaveLength(3);

    nextMinute();
    await api("PUT", "/api/notifications/schedule", {
      ...closedHours,
      followSlack: false,
    });
    await completeDashboardTurn("Slack is ignored.");
    expect(pushes).toHaveLength(3);
  });
});
