import { createECDH, randomBytes, randomUUID, type ECDH } from "node:crypto";
import { createRequire } from "node:module";
import {
  createWebSource,
  type Identity,
  type User,
} from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import webPush from "web-push";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import {
  saveNotificationSchedule,
  savePushSubscription,
} from "@/chat/notifications/store";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createConversationWorkQueueTestAdapter } from "../fixtures/conversation-work";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";
import { mswServer } from "../msw/server";

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
const ENV_NAMES = [
  "JUNIOR_WEB_PUSH_PUBLIC_KEY",
  "JUNIOR_WEB_PUSH_PRIVATE_KEY",
  "JUNIOR_WEB_PUSH_SUBJECT",
] as const;

const queue = createConversationWorkQueueTestAdapter();
const services = createSlackInboxItemToolServices(() => queue);

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
  return ana;
}

/** Tools of a Turn that Ana started, in the dashboard or a Slack thread. */
async function turnTools(
  ana: User,
  where: "dashboard" | "slack" = "dashboard",
) {
  const conversationId =
    where === "slack" ? "slack:C1:1.000001" : `local:web:${randomUUID()}`;
  await getConversationStore().recordActivity({
    conversationId,
    destination:
      where === "slack"
        ? {
            channelId: "C1",
            platform: "slack",
            teamId: "T123",
            threadTs: "1.000001",
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
    add: createAddInboxItemTool(context, services),
    update: createUpdateInboxItemTool(context, services),
  };
}

const ASK = {
  kind: "action",
  title: "Approve the deploy?",
  body: "**Deploy** of `api` waits for you.",
  assignees: ["ana@example.com"],
  dedupe_key: "deploy:api",
  request: {
    question: "Approve the deploy?",
    fields: [
      {
        id: "decision",
        kind: "choice",
        label: "Decision",
        options: [{ label: "Approve" }, { label: "Reject" }],
      },
    ],
  },
};

describe("inbox item push", () => {
  const savedEnv = new Map<string, string | undefined>();
  let previousLinks: ReturnType<typeof setDashboardConversationLinkOptions>;
  let pushes: Record<string, unknown>[];

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
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    setDashboardConversationLinkOptions(previousLinks);
    await disconnectStateAdapter();
    await closeDb();
  });

  it("pushes a new ask to its assignee once, and closes it with the next push", async () => {
    const ana = await anaWithPhone();
    const tools = await turnTools(ana);

    const added = await execute(tools.add, ASK);
    expect(pushes).toEqual([
      {
        body: "Deploy of api waits for you.",
        tag: added.item.id,
        title: "Approve the deploy?",
        url: `https://junior.example.com/inbox?item=${added.item.id}`,
      },
    ]);

    // A change of the same ask does not push again.
    await execute(tools.add, { ...ASK, body: "The deploy still waits." });
    // Everyone items and notices show only in the Inbox.
    await execute(tools.add, {
      ...ASK,
      assignees: ["everyone"],
      dedupe_key: "deploy:web",
    });
    await execute(tools.add, {
      kind: "notice",
      title: "The deploy finished",
      body: "Nothing to do.",
      assignees: ["ana@example.com"],
      dedupe_key: "deploy:done",
    });
    expect(pushes).toHaveLength(1);

    // Web Push cannot close a notification by itself. The next push tells
    // the phone to close the push of the ask that closed.
    await execute(tools.update, {
      id: added.item.id,
      status: "dismissed",
      reason: "Deploy rolled back",
    });
    expect(pushes).toHaveLength(1);
    const next = await execute(tools.add, { ...ASK, dedupe_key: "deploy:db" });
    expect(pushes[1]).toMatchObject({
      close: [added.item.id],
      tag: next.item.id,
    });
  });

  it("does not push an item that Slack shows", async () => {
    const ana = await anaWithPhone();
    const tools = await turnTools(ana, "slack");

    await execute(tools.add, ASK);

    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    expect(pushes).toEqual([]);
  });
});
