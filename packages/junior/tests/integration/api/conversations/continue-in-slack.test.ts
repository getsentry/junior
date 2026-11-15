import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  continueConversationInSlackResponseSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import type { ConversationStore } from "@/chat/conversations/store";
import { getDb } from "@/chat/db";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import {
  getConversationWorkState,
  startConversationWork,
} from "@/chat/task-execution/store";
import { juniorDestinations } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  SLACK_BOT_USER_ID,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../../fixtures/conversation-work";
import { slackApiOutbox } from "../../../fixtures/slack-api-outbox";
import {
  chatGetPermalinkOk,
  chatPostMessageOk,
  conversationsInfoOk,
} from "../../../fixtures/slack/factories/api";
import { signedInViewer } from "../../../fixtures/user";
import { queueSlackApiResponse } from "../../../msw/handlers/slack-api";

const THREAD_TS = "1712345.0100";
const THREAD_URL = "https://example.slack.com/archives/C123/p17123450100";
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

function viewerApp(fixture: ConversationFixture) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", await signedInViewer(fixture.actor.email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return app;
}

function continueInSlack(
  app: ReturnType<typeof viewerApp>,
  conversationId: string,
  locationId: string,
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/continue-in-slack`,
    {
      body: JSON.stringify({ locationId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
}

async function readDetail(
  app: ReturnType<typeof viewerApp>,
  conversationId: string,
) {
  const response = await app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}`,
  );
  return conversationDetailReportSchema.parse(await response.json());
}

/** Store the public channel that the dashboard picker lists. */
async function publicChannelLocationId(
  fixture: ConversationFixture,
): Promise<string> {
  await fixture.conversationStore.recordDestinationVisibility({
    channelName: "proj-junior",
    destination: SLACK_DESTINATION,
    visibility: "public",
  });
  const [row] = await getDb()
    .select({ id: juniorDestinations.id })
    .from(juniorDestinations)
    .where(
      and(
        eq(juniorDestinations.provider, "slack"),
        eq(juniorDestinations.providerDestinationId, "C123"),
      ),
    );
  if (!row) throw new Error("Expected the channel Location");
  return row.id;
}

/** Answer the Slack calls of one move to a channel that Junior must join. */
function queueSlackMove() {
  queueSlackApiResponse("conversations.info", {
    body: conversationsInfoOk({
      channelId: "C123",
      isMember: false,
      name: "proj-junior",
    }),
  });
  queueSlackApiResponse("chat.postMessage", {
    body: chatPostMessageOk({ channel: "C123", ts: THREAD_TS }),
  });
  queueSlackApiResponse("chat.getPermalink", {
    body: chatGetPermalinkOk({ permalink: THREAD_URL }),
  });
}

describe("continue a dashboard conversation in Slack", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("starts a thread that Slack replies and dashboard messages share", async () => {
    const fixture = await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: fixture.actor,
        idempotencyKey: "continue-in-slack",
        message: "Draft the rollout plan.",
      },
      fixture,
    );
    const locationId = await publicChannelLocationId(fixture);
    const app = viewerApp(fixture);
    expect((await readDetail(app, conversationId)).canContinueInSlack).toBe(
      true,
    );

    queueSlackMove();
    const response = await continueInSlack(app, conversationId, locationId);
    expect(response.status).toBe(200);
    expect(
      continueConversationInSlackResponseSchema.parse(await response.json()),
    ).toEqual({
      channelName: "proj-junior",
      conversationId,
      locationUrl: THREAD_URL,
    });
    expect(slackApiOutbox.calls("conversations.join")).toHaveLength(1);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: "C123",
      text: expect.stringContaining(
        "moved this conversation here from the dashboard",
      ),
    });
    expect(slackApiOutbox.messages()[0]?.params["thread_ts"]).toBeUndefined();

    const detail = await readDetail(app, conversationId);
    expect(detail.canContinueInSlack).toBeUndefined();
    expect(detail.channelName).toBe("proj-junior");
    expect(detail.visibility).toBe("public");
    expect(
      (await fixture.conversationStore.get({ conversationId }))?.location,
    ).toMatchObject({ channelId: "C123", threadTs: THREAD_TS });

    // The move is one-way and happens once.
    const again = await continueInSlack(app, conversationId, locationId);
    expect(again.status).toBe(409);
    expect(slackApiOutbox.messages()).toHaveLength(1);

    // Queued and later dashboard messages carry the Slack Destination, so
    // the worker does not write the dashboard Destination back.
    await appendAndEnqueueWebMessage(
      {
        actor: fixture.actor,
        conversationId,
        idempotencyKey: "after-move",
        message: "Add a rollback step.",
      },
      fixture,
    );
    const work = await getConversationWorkState({
      conversationId,
      state: fixture.state,
    });
    expect(work?.messages.map((message) => message.destination)).toEqual([
      SLACK_DESTINATION,
      SLACK_DESTINATION,
    ]);

    // A mention in the new thread reaches the same Conversation.
    const slackAdapter = createSlackAdapterFixture();
    const before = fixture.queue.queuedMessages().length;
    const webhook = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> ship it`,
          threadTs: THREAD_TS,
          ts: "1712345.0200",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue: fixture.queue,
        runtime: createNoopSlackWebhookRuntime(),
        state: fixture.state,
      },
    });
    expect(webhook.status).toBe(200);
    expect(
      fixture.queue
        .queuedMessages()
        .slice(before)
        .map((message) => message.conversationId),
    ).toEqual([conversationId]);
  });

  it("sends a dashboard message that races the move to Slack", async () => {
    const fixture = await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: fixture.actor,
        idempotencyKey: "race-root",
        message: "Draft the rollout plan.",
      },
      fixture,
    );
    const locationId = await publicChannelLocationId(fixture);
    const app = viewerApp(fixture);
    queueSlackMove();
    // The move lands after the send reads the dashboard Destination.
    let move: Response | undefined;
    const store = fixture.conversationStore;
    const conversationStore: ConversationStore = Object.create(store);
    conversationStore.get = async (args) => {
      const snapshot = await store.get(args);
      move ??= await continueInSlack(app, conversationId, locationId);
      return snapshot;
    };

    const sent = await appendAndEnqueueWebMessage(
      {
        actor: fixture.actor,
        conversationId,
        idempotencyKey: "during-move",
        message: "Add a rollback step.",
      },
      { ...fixture, conversationStore },
    );
    expect(move?.status).toBe(200);
    expect(sent.status).toBe("accepted");
    const work = await getConversationWorkState({
      conversationId,
      state: fixture.state,
    });
    expect(work?.messages.map((message) => message.destination)).toEqual([
      SLACK_DESTINATION,
      SLACK_DESTINATION,
    ]);
  });

  it("waits for a running Turn", async () => {
    const fixture = await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: fixture.actor,
        idempotencyKey: "busy-root",
        message: "Start a long Turn.",
      },
      fixture,
    );
    const lease = await startConversationWork({
      conversationId,
      conversationStore: fixture.conversationStore,
      state: fixture.state,
    });
    if (lease.status !== "acquired") throw new Error("Expected work lease");
    const locationId = await publicChannelLocationId(fixture);

    const response = await continueInSlack(
      viewerApp(fixture),
      conversationId,
      locationId,
    );
    expect(response.status).toBe(409);
    expect(
      (await fixture.conversationStore.get({ conversationId }))?.location,
    ).toBeUndefined();
    expect(slackApiOutbox.messages()).toHaveLength(0);
  });

  it("keeps private dashboard conversations out of Slack", async () => {
    const fixture = await createConversationFixture();
    const { conversationId } = await createAndEnqueueConversation(
      {
        actor: fixture.actor,
        idempotencyKey: "private-root",
        message: "Keep this between us.",
        visibility: "private",
      },
      fixture,
    );
    const locationId = await publicChannelLocationId(fixture);
    const app = viewerApp(fixture);
    expect(
      (await readDetail(app, conversationId)).canContinueInSlack,
    ).toBeUndefined();

    const response = await continueInSlack(app, conversationId, locationId);
    expect(response.status).toBe(409);
    expect(slackApiOutbox.messages()).toHaveLength(0);
  });
});
