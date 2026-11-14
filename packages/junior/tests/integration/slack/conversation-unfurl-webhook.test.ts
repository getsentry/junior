import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore } from "@/chat/db";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  ackMessages,
  completeConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { webTestActor } from "../../fixtures/conversation";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { linkSlackUser } from "../../fixtures/slack-user";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { chatPostMessageOk } from "../../fixtures/slack/factories/api";

const ORIGINAL_ENV = { ...process.env };
const DASHBOARD = "https://junior.example.com";
// The message that shares the link. Its thread takes the Conversation.
const SHARED_TS = "1712345.0001";

function unfurlsOf(call: { params: Record<string, unknown> } | undefined) {
  const unfurls = call?.params["unfurls"];
  return (typeof unfurls === "string" ? JSON.parse(unfurls) : unfurls) as
    | Record<
        string,
        {
          blocks: Array<{
            elements?: Array<{ action_id?: string; text?: unknown }>;
            text?: { text: string };
            type: string;
          }>;
        }
      >
    | undefined;
}

function harness() {
  const state = getStateAdapter();
  const queue = createConversationWorkQueueTestAdapter();
  const slackAdapter = createSlackAdapterFixture();
  const client = createSlackWebhookTestClient({
    signingSecret: SLACK_SIGNING_SECRET,
  });
  const services = {
    getSlackAdapter: () => slackAdapter,
    queue,
    runtime: createNoopSlackWebhookRuntime(),
    state,
  };
  async function send(request: Request) {
    const waitUntil = client.waitUntil();
    const response = await handleSlackWebhook({
      request,
      services,
      waitUntil: waitUntil.fn,
    });
    expect(response.status).toBe(200);
    await waitUntil.flush();
  }
  return {
    queue,
    state,
    /** A dashboard conversation started by Alice. */
    async startConversation(
      visibility: "private" | "public",
      idempotencyKey = `root-${visibility}`,
    ) {
      await state.connect();
      const { conversationId, messageId } = await createAndEnqueueConversation(
        {
          actor: webTestActor,
          idempotencyKey,
          message: "Draft the rollout plan.",
          visibility,
        },
        { conversationStore: getConversationStore(), queue, state },
      );
      return {
        conversationId,
        messageId,
        url: `${DASHBOARD}/conversations/${encodeURIComponent(conversationId)}`,
      };
    },
    shareLink: (...urls: string[]) =>
      send(
        client.event({
          type: "event_callback",
          team_id: "T123",
          event_id: "Ev_link",
          event: {
            type: "link_shared",
            channel: "C123",
            user: "U123",
            message_ts: SHARED_TS,
            unfurl_id: "C123.1712345.0001.abc",
            source: "conversations_history",
            links: urls.map((url) => ({ domain: "junior.example.com", url })),
          },
        }),
      ),
    click: (userId: string, value: string) =>
      send(
        client.form(
          new URLSearchParams({
            payload: JSON.stringify({
              type: "block_actions",
              team: { id: "T123" },
              trigger_id: "trigger-1",
              user: { id: userId, team_id: "T123" },
              channel: { id: "C123" },
              actions: [
                {
                  action_id: "junior_continue_here",
                  action_ts: "1712345.0050",
                  type: "button",
                  value,
                },
              ],
            }),
          }),
        ),
      ),
    mention: (ts: string) =>
      send(
        client.event({
          ...slackEventsApiEnvelope({
            channel: "C123",
            eventType: "app_mention",
            text: `<@${SLACK_BOT_USER_ID}> ship it`,
            threadTs: SHARED_TS,
            ts,
            user: "U123",
          }),
          event_id: `Ev_${ts}`,
        }),
      ),
  };
}

/** The value of the "Continue here" button in the latest preview. */
function continueHereValue(url: string): string | undefined {
  const preview = unfurlsOf(slackApiOutbox.calls("chat.unfurl").at(-1))?.[url];
  const button = preview?.blocks
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === "junior_continue_here") as
    | { value?: string }
    | undefined;
  return button?.value;
}

describe("Slack webhook: dashboard conversation links", () => {
  let previousDashboard: ReturnType<typeof setDashboardConversationLinkOptions>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
    resetSlackApiMockState();
    previousDashboard = setDashboardConversationLinkOptions({
      baseURL: DASHBOARD,
    });
  });

  afterEach(async () => {
    setDashboardConversationLinkOptions(previousDashboard);
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
    await closeDb();
  });

  it("moves a public dashboard conversation into the thread of the shared link", async () => {
    const slack = harness();
    const { conversationId, url } = await slack.startConversation("public");
    await linkSlackUser(webTestActor.email, "U123");

    await slack.shareLink(url);
    const preview = unfurlsOf(slackApiOutbox.calls("chat.unfurl")[0]);
    expect(Object.keys(preview ?? {})).toEqual([url]);
    // The unfurl id works before Junior joins the channel.
    expect(slackApiOutbox.calls("chat.unfurl")[0]?.params).toMatchObject({
      source: "conversations_history",
      unfurl_id: "C123.1712345.0001.abc",
    });
    const value = continueHereValue(url);
    expect(value).toBeDefined();

    await slack.click("U123", value!);
    // Junior replies under the shared message and the thread is the
    // Conversation Location.
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: SHARED_TS,
      text: expect.stringContaining(
        "moved this conversation here from the dashboard",
      ),
    });
    expect(
      (await getConversationStore().get({ conversationId }))?.location,
    ).toMatchObject({ channelId: "C123", threadTs: SHARED_TS });
    // The preview drops the button and links the thread.
    expect(slackApiOutbox.calls("chat.unfurl")).toHaveLength(2);
    expect(continueHereValue(url)).toBeUndefined();
    expect(
      JSON.stringify(unfurlsOf(slackApiOutbox.calls("chat.unfurl")[1])),
    ).toContain("Continues in");
    // The move joined the channel, so the update uses the message.
    expect(slackApiOutbox.calls("chat.unfurl")[1]?.params).toMatchObject({
      channel: "C123",
      ts: SHARED_TS,
    });

    // A later mention in the thread reaches the same Conversation.
    const before = slack.queue.queuedMessages().length;
    await slack.mention("1712345.0200");
    expect(
      slack.queue
        .queuedMessages()
        .slice(before)
        .map((message) => message.conversationId),
    ).toEqual([conversationId]);

    // A click on the old button says where the conversation went.
    await slack.click("U123", value!);
    expect(
      slackApiOutbox.calls("chat.postEphemeral").at(-1)?.params["text"],
    ).toMatch(/^This conversation already continues in .+: https:\/\//);

    // A new share of a moved conversation has no button.
    await slack.shareLink(url);
    expect(continueHereValue(url)).toBeUndefined();
  });

  it("moves a conversation here when the Run that holds it ends", async () => {
    const slack = harness();
    const { conversationId, messageId, url } =
      await slack.startConversation("public");
    await linkSlackUser(webTestActor.email, "U123");
    await slack.shareLink(url);
    const value = continueHereValue(url)!;
    // A Run holds the Conversation and still runs post-reply work.
    const lease = await startConversationWork({ conversationId });
    if (lease.status !== "acquired") throw new Error("Expected work lease");
    await ackMessages({
      conversationId,
      inboundMessageIds: [messageId],
      leaseToken: lease.leaseToken,
    });

    await slack.click("U123", value);
    // A repeat click waits for the same move.
    await slack.click("U123", value);
    // A click from another thread does not replace the first one.
    await slack.click(
      "U123",
      JSON.stringify({
        ...JSON.parse(value),
        messageTs: "1712345.0300",
        threadTs: "1712345.0300",
      }),
    );
    expect(
      slackApiOutbox.calls("chat.postEphemeral").map((call) => call.params),
    ).toEqual([
      expect.objectContaining({
        user: "U123",
        text: "This conversation moves here when Junior finishes.",
      }),
      expect.objectContaining({
        text: "This conversation moves here when Junior finishes.",
      }),
      expect.objectContaining({
        text: "This conversation moves to another thread when Junior finishes.",
      }),
    ]);
    expect(slackApiOutbox.messages()).toHaveLength(0);
    expect(
      (await getConversationStore().get({ conversationId }))?.location,
    ).toBeUndefined();

    await completeConversationWork({
      conversationId,
      leaseToken: lease.leaseToken,
    });
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(slackApiOutbox.messages()[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: SHARED_TS,
      text: expect.stringContaining(
        "moved this conversation here from the dashboard",
      ),
    });
    expect(
      (await getConversationStore().get({ conversationId }))?.location,
    ).toMatchObject({ channelId: "C123", threadTs: SHARED_TS });
    expect(continueHereValue(url)).toBeUndefined();
    expect(
      JSON.stringify(unfurlsOf(slackApiOutbox.calls("chat.unfurl").at(-1))),
    ).toContain("Continues in");

    const before = slack.queue.queuedMessages().length;
    await slack.mention("1712345.0200");
    expect(
      slack.queue
        .queuedMessages()
        .slice(before)
        .map((message) => message.conversationId),
    ).toEqual([conversationId]);
  });

  it("tells the clicker when the thread was taken while the move waited", async () => {
    const slack = harness();
    const first = await slack.startConversation("public", "first");
    const second = await slack.startConversation("public", "second");
    await linkSlackUser(webTestActor.email, "U123");
    await slack.shareLink(first.url, second.url);
    const values = [
      continueHereValue(first.url)!,
      continueHereValue(second.url)!,
    ];
    const lease = await startConversationWork({
      conversationId: first.conversationId,
    });
    if (lease.status !== "acquired") throw new Error("Expected work lease");

    await slack.click("U123", values[0]!);
    await slack.click("U123", values[1]!);
    await completeConversationWork({
      conversationId: first.conversationId,
      leaseToken: lease.leaseToken,
    });
    expect(
      (
        await getConversationStore().get({
          conversationId: first.conversationId,
        })
      )?.location,
    ).toBeUndefined();
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(
      slackApiOutbox.calls("chat.postEphemeral").at(-1)?.params["text"],
    ).toBe("This thread already has a Junior conversation.");
  });

  it("moves only one of two conversations that race for the same thread", async () => {
    const slack = harness();
    const first = await slack.startConversation("public", "first");
    const second = await slack.startConversation("public", "second");
    await linkSlackUser(webTestActor.email, "U123");
    await slack.shareLink(first.url, second.url);
    const values = [
      continueHereValue(first.url),
      continueHereValue(second.url),
    ];

    // Hold the first reply until the second click posts too, so both
    // clicks pass the early thread check.
    let secondPosted!: () => void;
    const bothPosted = new Promise<void>((resolve) => {
      secondPosted = resolve;
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({ ts: "1712345.0101" }),
      waitFor: bothPosted,
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({ ts: "1712345.0102" }),
      onRequest: () => secondPosted(),
    });
    await Promise.all(values.map((value) => slack.click("U123", value!)));
    const locations = await Promise.all(
      [first, second].map(
        async ({ conversationId }) =>
          (await getConversationStore().get({ conversationId }))?.location,
      ),
    );
    expect(locations.filter(Boolean)).toHaveLength(1);
    // The loser removes its extra reply and tells the clicker.
    expect(
      slackApiOutbox.messages().length -
        slackApiOutbox.calls("chat.delete").length,
    ).toBe(1);
    expect(slackApiOutbox.calls("chat.postEphemeral")).toHaveLength(1);
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params["text"]).toBe(
      "This thread already has a Junior conversation.",
    );
  });

  it("lets someone outside a public conversation move it", async () => {
    const slack = harness();
    const { conversationId, url } = await slack.startConversation("public");
    await linkSlackUser("ben@example.com", "U456");
    await slack.shareLink(url);

    await slack.click("U456", continueHereValue(url)!);
    expect(slackApiOutbox.calls("chat.postEphemeral")).toHaveLength(0);
    expect(slackApiOutbox.messages()).toHaveLength(1);
    expect(
      (await getConversationStore().get({ conversationId }))?.location,
    ).toMatchObject({ channelId: "C123", threadTs: SHARED_TS });
  });

  it("shows nothing for a private conversation and refuses a forged click", async () => {
    const slack = harness();
    const { conversationId, url } = await slack.startConversation("private");
    await linkSlackUser(webTestActor.email, "U123");

    await slack.shareLink(url);
    expect(slackApiOutbox.calls("chat.unfurl")).toHaveLength(0);

    await slack.click(
      "U123",
      JSON.stringify({
        conversationId,
        messageTs: SHARED_TS,
        threadTs: SHARED_TS,
        url,
      }),
    );
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params["text"]).toBe(
      "Only public conversations can move here.",
    );
    expect(slackApiOutbox.messages()).toHaveLength(0);
    expect(
      (await getConversationStore().get({ conversationId }))?.location,
    ).toBeUndefined();
  });
});
