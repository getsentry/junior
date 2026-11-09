import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSource, type Identity } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  conversationFeedSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { createConversationSubscriptionTools } from "@/chat/tools/conversation-subscription";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";

// The contract is the comment at the top of
// `src/api/conversations/subscription.ts`. Each test is one of its
// scenarios. Tests go through the public API, the agent tool, and stored
// Slack Turns only, so storage can change without test changes.

const CONVERSATION_ID = "slack:C1:subscription";
let nowMs = 1_000;

/** A dashboard viewer who is also a Slack user in the same workspace. */
async function person(name: string) {
  const email = `${name}@example.com`;
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const identityId = await resolveActorIdentityId(getSqlExecutor(), {
    email,
    platform: "slack",
    teamId: "T1",
    userId: `U-${name}`,
  });
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const api = (path: string, init?: RequestInit) =>
    app.request(`http://localhost/api/conversations${path}`, init);
  const patch = (path: string, body: unknown) =>
    api(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
  return {
    identityId: identityId!,
    viewer,
    async feed(query = "") {
      const response = await api(query);
      expect(response.status).toBe(200);
      return conversationFeedSchema
        .parse(await response.json())
        .conversations.map((conversation) => conversation.conversationId);
    },
    async open() {
      const response = await api(`/${CONVERSATION_ID}`);
      expect(response.status).toBe(200);
      return conversationDetailReportSchema.parse(await response.json());
    },
    async pin() {
      const response = await patch(`/${CONVERSATION_ID}/pin`, {
        pinned: true,
      });
      expect(response.status).toBe(200);
    },
    async restore() {
      const response = await patch(`/${CONVERSATION_ID}/archive`, {
        archived: false,
        lastSeenAt: new Date(nowMs).toISOString(),
      });
      expect(response.status).toBe(200);
    },
    async setSubscribed(subscribed: boolean) {
      const response = await patch(`/${CONVERSATION_ID}/subscription`, {
        subscribed,
      });
      expect(response.status).toBe(200);
    },
  };
}

type Person = Awaited<ReturnType<typeof person>>;

/** Call the agent tool in a Turn that `actor` started in this Conversation. */
async function agentSetsSubscription(actor: Person, subscribed: boolean) {
  const identity: Identity = {
    id: actor.identityId,
    provider: "slack",
    providerSubjectId: actor.identityId,
  };
  const context = {
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    egress: { fetch: async () => new Response("ok") },
    resolveActorIdentity: async () => ({ identity, user: actor.viewer }),
    source: createLocalSource(CONVERSATION_ID),
    workspace: {} as ToolRuntimeContext["workspace"],
  } as ToolRuntimeContext;
  const tool =
    createConversationSubscriptionTools(context).setConversationSubscription;
  if (!tool?.execute || !tool.prepareArguments) {
    throw new Error("setConversationSubscription is missing");
  }
  return await tool.execute(tool.prepareArguments({ subscribed }), {});
}

/** Store one Slack Message from the person, and a Turn that reads it. */
async function say(someone: Person, mentionsJunior: boolean) {
  nowMs += 1_000;
  const messageId = `message-${nowMs}`;
  await getConversationEventStore().append(CONVERSATION_ID, [
    {
      createdAtMs: nowMs,
      data: {
        authorIdentityId: someone.identityId,
        messageId,
        meta: { explicitMention: mentionsJunior, source: "slack" },
        role: "user",
        text: messageId,
        type: "message",
      },
      idempotencyKey: `message:${messageId}`,
    },
    {
      createdAtMs: nowMs + 1,
      data: {
        inputMessageIds: [messageId],
        surface: "slack",
        turnId: `turn-${messageId}`,
        type: "turn_started",
      },
      idempotencyKey: `turn:${messageId}:started`,
    },
  ]);
}

/** Given Ana and Ben both mentioned Junior in one Slack thread. */
async function sharedThread(starter?: string) {
  // The starter's Slack actor has no email, so no User exists yet and they
  // get no participant row. `person(starter)` links a User later.
  await getConversationStore().recordActivity({
    ...(starter
      ? {
          actor: {
            platform: "slack" as const,
            slackUserId: `U-${starter}`,
            teamId: "T1",
          },
        }
      : undefined),
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    nowMs,
    source: "internal",
    title: "Shared thread",
    visibility: "public",
  });
  const ana = await person("ana");
  const ben = await person("ben");
  await say(ana, true);
  await say(ben, true);
  expect(await ana.feed()).toEqual([CONVERSATION_ID]);
  expect(await ben.feed()).toEqual([CONVERSATION_ID]);
  return { ana, ben };
}

describe("conversation subscription", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("unsubscribing removes it from only your feed, and you keep access", async () => {
    const { ana, ben } = await sharedThread();

    await ana.setSubscribed(false);

    expect(await ana.feed()).toEqual([]);
    expect(await ben.feed()).toEqual([CONVERSATION_ID]);
    expect(await ana.open()).toMatchObject({ subscribed: false });
    expect(await ana.feed("?q=shared")).toEqual([CONVERSATION_ID]);
  });

  it("stays out of your feed until you address Junior again", async () => {
    const { ana, ben } = await sharedThread();
    await ana.setSubscribed(false);

    await say(ben, true);
    await say(ana, false);
    expect(await ana.feed()).toEqual([]);

    await say(ana, true);
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);
    expect(await ana.open()).toMatchObject({ subscribed: true });
  });

  it("pin and subscribe also bring it back, and unsubscribe drops the pin", async () => {
    const { ana } = await sharedThread();
    await ana.pin();

    await ana.setSubscribed(false);
    expect((await ana.open()).pinnedAt).toBeFalsy();
    await ana.pin();
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);

    await ana.setSubscribed(false);
    await ana.setSubscribed(true);
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);
  });

  it("the last subscriber leaving archives it for everyone", async () => {
    const { ana, ben } = await sharedThread();

    await ana.setSubscribed(false);
    expect((await ben.open()).archivedAt).toBeFalsy();
    await ben.setSubscribed(false);
    expect((await ana.open()).archivedAt).toEqual(expect.any(String));
    expect(await ana.feed("?status=archived")).toEqual([CONVERSATION_ID]);
  });

  it("the person who started it counts as subscribed before they post", async () => {
    const { ana, ben } = await sharedThread("cleo");
    const cleo = await person("cleo");
    expect(await cleo.feed()).toEqual([CONVERSATION_ID]);

    await ana.setSubscribed(false);
    await ben.setSubscribed(false);
    expect((await cleo.open()).archivedAt).toBeFalsy();
    expect(await cleo.feed()).toEqual([CONVERSATION_ID]);
  });

  it("the agent tool changes only the person who started the Turn", async () => {
    const { ana, ben } = await sharedThread();
    const cleo = await person("cleo");

    await agentSetsSubscription(ana, false);
    expect(await ana.feed()).toEqual([]);
    expect(await ben.feed()).toEqual([CONVERSATION_ID]);

    await agentSetsSubscription(ana, true);
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);
    await expect(agentSetsSubscription(cleo, false)).rejects.toBeInstanceOf(
      ToolInputError,
    );
  });

  it("whoever restores an archived conversation is subscribed again", async () => {
    const { ana, ben } = await sharedThread();
    await ana.setSubscribed(false);
    await ben.setSubscribed(false);

    // A Message that does not address Junior still restores the archive.
    await say(ben, false);
    expect(await ben.feed()).toEqual([CONVERSATION_ID]);
    expect(await ana.feed()).toEqual([]);

    await ben.setSubscribed(false);
    await ana.restore();
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);
  });
});
