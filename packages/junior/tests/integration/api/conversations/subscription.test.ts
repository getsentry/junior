import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSource, type Identity } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import {
  CONVERSATION_VERSION_HEADER,
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
import { createSetConversationSubscriptionTool } from "@/chat/tools/conversation-subscription";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";
import { setSlackChannelMembers } from "../../../msw/handlers/slack-api";

const rootTurnTools = turnBehavior({
  kind: "root",
  personInput: true,
}).tools;

// The contract is the comment at the top of
// `src/api/conversations/subscription.ts`. Each test is one of its
// scenarios. Tests go through the public API, the agent tool, and stored
// Slack Turns only, so storage can change without test changes.

const CONVERSATION_ID = "slack:C1:subscription";
let nowMs = 1_000;

/** The Slack user id of a test person, such as `UANA`. */
function slackUserId(name: string): string {
  return `U${name.toUpperCase()}`;
}

/** A dashboard viewer who is also a Slack user, by default in this workspace. */
async function person(name: string, teamId = "T1") {
  const email = `${name}@example.com`;
  await resolveViewerUser(email);
  const identityId = await resolveActorIdentityId(getSqlExecutor(), {
    email,
    platform: "slack",
    teamId,
    userId: slackUserId(name),
  });
  // Read the viewer again so it carries the linked Slack account.
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
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
    /** Call the Conversations API as this person. */
    api,
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
    /** Whether the detail shows them the transcript. */
    async canRead() {
      return (await this.open()).eventHistory.status === "available";
    },
    /** Invite a mentioned person by Slack user id. Returns the response. */
    async invite(slackUserId: string) {
      return await api(`/${CONVERSATION_ID}/invites`, {
        body: JSON.stringify({ slackUserId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    /** Send a dashboard Message. */
    async post(message: string) {
      nowMs += 1_000;
      const response = await api(`/${CONVERSATION_ID}/messages`, {
        body: JSON.stringify({ idempotencyKey: `post-${nowMs}`, message }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(response.status).toBe(200);
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
    turnTools: rootTurnTools,
    conversationId: CONVERSATION_ID,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    egress: { fetch: async () => new Response("ok") },
    resolveActorIdentity: async () => ({ identity, user: actor.viewer }),
    source: createLocalSource(CONVERSATION_ID),
    workspace: {} as ToolRuntimeContext["workspace"],
  } as ToolRuntimeContext;
  const tool = createSetConversationSubscriptionTool(context);
  if (!tool.execute || !tool.prepareArguments) {
    throw new Error("setConversationSubscription is missing");
  }
  return await tool.execute(tool.prepareArguments({ subscribed }), {});
}

/** Store one Slack Message from the person, and a Turn that reads it. */
async function say(someone: Person, mentionsJunior: boolean, text?: string) {
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
        text: text ?? messageId,
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
async function sharedThread(
  starter?: string,
  visibility: "private" | "public" = "public",
) {
  // The starter's Slack actor has no email, so no User exists yet and they
  // get no participant row. `person(starter)` links a User later.
  setSlackChannelMembers("C1", [slackUserId("ana"), slackUserId("ben")]);
  await getConversationStore().recordActivity({
    ...(starter
      ? {
          actor: {
            platform: "slack" as const,
            slackUserId: slackUserId(starter),
            teamId: "T1",
          },
        }
      : undefined),
    conversationId: CONVERSATION_ID,
    destination: { channelId: "C1", platform: "slack", teamId: "T1" },
    nowMs,
    source: "internal",
    title: "Shared thread",
    visibility,
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

  it("Invite adds a mentioned person to the feed of a public conversation", async () => {
    const { ana, ben } = await sharedThread();
    const cleo = await person("cleo");
    expect(await cleo.feed()).toEqual([]);

    const invited = await ana.invite(slackUserId("cleo"));
    expect(invited.status).toBe(200);
    expect(await invited.json()).toEqual({ added: true });
    expect(await cleo.feed()).toEqual([CONVERSATION_ID]);
    expect(await cleo.open()).toMatchObject({ subscribed: true });

    // An existing Participant keeps their own choice to unsubscribe.
    await ben.setSubscribed(false);
    expect(await (await ana.invite(slackUserId("ben"))).json()).toEqual({
      added: false,
    });
    expect(await ben.feed()).toEqual([]);
  });

  it("a dashboard Message that mentions a person adds them, like Invite", async () => {
    const { ana, ben } = await sharedThread();
    const cleo = await person("cleo");
    await ben.setSubscribed(false);

    await ana.post(`<@${slackUserId("cleo")}> <@${slackUserId("ben")}> look`);
    expect(await cleo.feed()).toEqual([CONVERSATION_ID]);
    expect(await ben.feed()).toEqual([]);
  });

  it("a Slack Message that mentions a person adds them, like Invite", async () => {
    const { ana, ben } = await sharedThread();
    const cleo = await person("cleo");
    await ben.setSubscribed(false);

    await say(
      ana,
      false,
      `<@${slackUserId("cleo")}> <@${slackUserId("ben")}> look`,
    );
    expect(await cleo.feed()).toEqual([CONVERSATION_ID]);
    expect(await ben.feed()).toEqual([]);
  });

  it("a Message in a private conversation adds nobody it mentions", async () => {
    const { ana } = await sharedThread(undefined, "private");
    const cleo = await person("cleo");

    await ana.post(`<@${slackUserId("cleo")}> look`);
    await say(ana, true, `<@${slackUserId("cleo")}> look`);
    expect(await cleo.feed("?q=shared")).toEqual([]);
  });

  it("a Slack-backed private conversation follows its channel's members now", async () => {
    const { ben } = await sharedThread(undefined, "private");
    const cleo = await person("cleo");
    const dave = await person("dave");
    await say(dave, true);
    // Dave posted, then left the channel. Cleo is in it and never posted.
    setSlackChannelMembers("C1", [slackUserId("ben"), slackUserId("cleo")]);

    expect(await dave.canRead()).toBe(false);
    expect(await ben.canRead()).toBe(true);
    expect(await cleo.canRead()).toBe(true);
    await cleo.post("joining in");
  });

  it("Invite on a Slack-backed private conversation is refused and shares nothing", async () => {
    const { ana } = await sharedThread(undefined, "private");
    const cleo = await person("cleo");

    const invited = await ana.invite(slackUserId("cleo"));
    expect(invited.status).toBe(404);
    expect(await cleo.feed()).toEqual([]);
    expect(await cleo.feed("?q=shared")).toEqual([]);
  });

  it("Invite names a person of the conversation's Slack workspace", async () => {
    const { ana } = await sharedThread();
    const dana = await person("dana", "T2");

    expect((await ana.invite(slackUserId("dana"))).status).toBe(404);
    expect(await dana.feed()).toEqual([]);
  });

  it("Invite on an archived conversation is refused", async () => {
    const { ana, ben } = await sharedThread();
    const cleo = await person("cleo");
    await ana.setSubscribed(false);
    await ben.setSubscribed(false);

    expect((await ana.invite(slackUserId("cleo"))).status).toBe(409);
    expect(await cleo.feed("?status=archived")).toEqual([]);
  });
});

/** Ana starts a private dashboard Conversation and is its only Participant. */
async function privateDashboardConversation() {
  const ana = await person("ana");
  const response = await ana.api("", {
    body: JSON.stringify({
      idempotencyKey: "private-start",
      message: "Private plan",
      title: "Private plan",
      visibility: "private",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const { conversationId } = (await response.json()) as {
    conversationId: string;
  };
  const path = `/${encodeURIComponent(conversationId)}`;
  const as = (someone: Person) => ({
    invite: (name: string) =>
      someone.api(`${path}/invites`, {
        body: JSON.stringify({ slackUserId: slackUserId(name) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    leave: () => someone.api(`${path}/leave`, { method: "POST" }),
    open: async () => {
      const response = await someone.api(path);
      expect(response.status).toBe(200);
      return conversationDetailReportSchema.parse(await response.json());
    },
    /** The version token that this person's detail polls compare. */
    version: async () =>
      (await someone.api(path)).headers.get(CONVERSATION_VERSION_HEADER),
    /** Whether this person can read the Conversation's private content. */
    reads: async () => {
      const detail = await as(someone).open();
      return detail.eventHistory.status !== "redacted";
    },
  });
  return { ana, as, conversationId };
}

describe("private conversation membership", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("any Participant can Invite a person, which shares it", async () => {
    const { ana, as } = await privateDashboardConversation();
    const ben = await person("ben");
    const cleo = await person("cleo");
    expect(await as(ben).reads()).toBe(false);
    expect(await as(ana).open()).toMatchObject({
      canInvite: true,
      leaveEndsAccess: true,
    });

    // Someone outside cannot add themselves or anyone else.
    expect((await as(ben).invite("cleo")).status).toBe(404);

    const before = await as(ana).version();
    expect(await (await as(ana).invite("ben")).json()).toEqual({
      added: true,
    });
    expect(await as(ben).reads()).toBe(true);
    // Ana's open page polls the version, and the Participants changed.
    expect(await as(ana).version()).not.toBe(before);
    expect(await (await as(ben).invite("cleo")).json()).toEqual({
      added: true,
    });
    expect(await as(cleo).reads()).toBe(true);
  });

  it("a Participant leaves on their own and loses access", async () => {
    const { ana, as } = await privateDashboardConversation();
    const ben = await person("ben");
    await as(ana).invite("ben");

    // Nobody can remove another person: leave acts only on the caller.
    expect((await as(ben).leave()).status).toBe(200);
    expect(await as(ben).reads()).toBe(false);
    expect((await as(ben).leave()).status).toBe(404);
    expect(await as(ana).reads()).toBe(true);
  });

  it("the person who started it stays out after they leave", async () => {
    const { ana, as, conversationId } = await privateDashboardConversation();
    const ben = await person("ben");
    await as(ana).invite("ben");
    expect((await as(ana).leave()).status).toBe(200);

    // A later Turn writes the root again.
    await getConversationStore().recordActivity({ conversationId });
    expect(await as(ana).reads()).toBe(false);
    expect(await as(ben).reads()).toBe(true);
  });

  it("the last subscriber leaving archives it for everyone", async () => {
    const { ana, as, conversationId } = await privateDashboardConversation();
    const ben = await person("ben");
    await as(ana).invite("ben");
    const benPath = `/${encodeURIComponent(conversationId)}/subscription`;
    expect(
      (
        await ben.api(benPath, {
          body: JSON.stringify({ subscribed: false }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        })
      ).status,
    ).toBe(200);

    const left = await as(ana).leave();
    expect(left.status).toBe(200);
    expect(
      ((await left.json()) as { archivedAt: string | null }).archivedAt,
    ).not.toBeNull();
    expect(await ben.feed("?status=archived")).toEqual([conversationId]);
  });

  it("a mention in a private Message adds nobody: only Invite shares it", async () => {
    const { ana, as, conversationId } = await privateDashboardConversation();
    const ben = await person("ben");
    const response = await ana.api(
      `/${encodeURIComponent(conversationId)}/messages`,
      {
        body: JSON.stringify({
          idempotencyKey: "private-mention",
          message: `<@${slackUserId("ben")}> look`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    expect(await as(ben).reads()).toBe(false);
  });

  it("Leave on a public conversation only takes it out of your feed", async () => {
    const { ana, ben } = await sharedThread();
    expect(await ana.open()).not.toHaveProperty("leaveEndsAccess");
    const left = await ana.api(`/${CONVERSATION_ID}/leave`, {
      method: "POST",
    });
    expect(left.status).toBe(200);

    // It stays public, so Ana can still find it and join again.
    expect(await ana.feed()).toEqual([]);
    expect(await ben.feed()).toEqual([CONVERSATION_ID]);
    expect(await ana.feed("?q=shared")).toEqual([CONVERSATION_ID]);
    await ana.setSubscribed(true);
    expect(await ana.feed()).toEqual([CONVERSATION_ID]);
  });
});
