import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDispatchRecord } from "@/chat/agent-dispatch/store";
import { getConversationStore } from "@/chat/db";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { getEventAutomation } from "@/chat/event-automations/store";
import { getEventCatalog } from "@/chat/events/runtime-catalog";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createEventAutomationTool } from "@/chat/tools/create-event-automation";
import { createUpdateEventAutomationTool } from "@/chat/tools/update-event-automation";
import { createWatchEventsTool } from "@/chat/tools/watch-events";
import { juniorAutomations } from "@/db/schema/automations";
import { context, execute } from "../../fixtures/event-automations";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import {
  createConfiguredJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "../../fixtures/sql";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  process.env.JUNIOR_SECRET = "channel-message-automation-test-secret";
});

// Slack webhook fixtures post from workspace T123 in channel C123.
const TEAM_ID = "T123";

let fixture: LocalJuniorSqlFixture;
let queue: ConversationWorkQueueTestAdapter;

function trigger(
  identifier = "current_channel",
  match?: Record<string, string>,
) {
  return {
    namespace: "slack",
    identifier,
    resourceType: "channel",
    label: "New messages in #discuss-integration",
    events: ["message.posted"],
    ...(match ? { match } : undefined),
  };
}

async function postChannelMessage(input: {
  botId?: string;
  channel?: string;
  threadTs?: string;
  ts: string;
  user?: string;
}) {
  const state = getStateAdapter();
  await state.connect();
  const slackAdapter = createSlackAdapterFixture();
  const { botId, ...message } = input;
  const envelope = slackEnvelope({
    eventType: "message",
    text: "How do I connect the Jira integration?",
    ...message,
  });
  if (botId) Object.assign(envelope.event, { bot_id: botId });
  return await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(envelope),
    services: {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    },
  });
}

describe("Slack channel-message automations", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
    resetSlackApiMockState();
    fixture = createConfiguredJuniorSqlFixture();
    await migrateSchema(fixture.sql);
    queue = createConversationWorkQueueTestAdapter();
    // The automation tools save cards to the creation Conversation.
    await getConversationStore().recordActivity({
      conversationId: "test:event-annotations",
      destination: {
        platform: "local",
        conversationId: "test:event-annotations",
      },
      source: "local",
      nowMs: Date.now(),
    });
  });

  afterEach(async () => {
    await fixture.sql
      .db()
      .delete(juniorAutomations)
      .where(eq(juniorAutomations.teamId, TEAM_ID));
    await fixture.close();
    await disconnectStateAdapter();
    vi.restoreAllMocks();
  });

  it("runs for new top-level messages in its own channel and replies in their threads", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const { automation } = (await execute(
      createEventAutomationTool(channelContext, catalog),
      {
        instruction: "Answer the question, or tag <@U123> if you can't.",
        title: "Triage discuss-integration",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger(),
      },
    )) as { automation: { id: string } };

    // The trigger binds to the channel, and runs never get creator credentials.
    expect(
      await getEventAutomation(fixture.sql.db(), automation.id),
    ).toMatchObject({
      credentialMode: "system",
      trigger: { identifier: "C123", namespace: "slack" },
    });

    // A thread reply, a bot post, and a message in another channel do not run it.
    expect(
      (
        await postChannelMessage({
          threadTs: "1712345.0001",
          ts: "1712345.0002",
        })
      ).status,
    ).toBe(200);
    expect(
      (await postChannelMessage({ botId: "B123", ts: "1712345.0005" })).status,
    ).toBe(200);
    expect(
      (await postChannelMessage({ channel: "C999", ts: "1712345.0003" }))
        .status,
    ).toBe(200);
    expect(queue.sentRecords()).toEqual([]);

    // A new top-level message runs it once, even when Slack delivers it twice.
    expect((await postChannelMessage({ ts: "1712345.0004" })).status).toBe(200);
    expect((await postChannelMessage({ ts: "1712345.0004" })).status).toBe(200);
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712345.0004" },
      metadata: { eventAutomationId: automation.id },
      outcomes: [
        {
          action: "send_message",
          destination: { channelId: "C123", threadTs: "1712345.0004" },
        },
      ],
    });
    expect(dispatch?.credentialSubject).toBeUndefined();
    expect(dispatch?.input).toContain("How do I connect the Jira integration?");

    // Creator credentials cannot be turned on later.
    await execute(createUpdateEventAutomationTool(channelContext, catalog), {
      automationId: automation.id,
      credentialMode: "creator",
    });
    expect(
      await getEventAutomation(fixture.sql.db(), automation.id),
    ).toMatchObject({ credentialMode: "system" });
  });

  it("runs for bot posts only when its match names the bot", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );
    const { automation } = (await execute(
      createEventAutomationTool(channelContext, catalog),
      {
        instruction: "Triage each new alert.",
        title: "Triage alerts",
        outcomes: [
          { action: "send_message", destination: "current_conversation" },
        ],
        trigger: trigger("current_channel", { userId: "U777" }),
      },
    )) as { automation: { id: string } };

    // A post from another bot does not run it.
    await postChannelMessage({
      botId: "B888",
      ts: "1712346.0001",
      user: "U888",
    });
    expect(queue.sentRecords()).toEqual([]);

    // A post from the named bot runs it and replies in the alert thread.
    await postChannelMessage({
      botId: "B777",
      ts: "1712346.0002",
      user: "U777",
    });
    const sent = queue.sentRecords();
    expect(sent).toHaveLength(1);
    const dispatch = await getDispatchRecord(
      sent[0]!.conversationId.replace(/^agent-dispatch:/, ""),
    );
    expect(dispatch).toMatchObject({
      destination: { channelId: "C123", threadTs: "1712346.0002" },
      metadata: { eventAutomationId: automation.id },
    });
  });

  it("watches only the channel where the automation posts", async () => {
    const catalog = getEventCatalog();
    const channelContext = context(
      "U123",
      "C123",
      "public",
      undefined,
      TEAM_ID,
    );

    await expect(
      execute(createEventAutomationTool(channelContext, catalog), {
        instruction: "Summarize new messages.",
        title: "Summarize secrets",
        outcomes: [],
        trigger: trigger("C999"),
      }),
    ).rejects.toThrow("can watch only the channel where it posts");

    // A DM is not a channel, so the automation could never run there.
    await expect(
      execute(
        createEventAutomationTool(
          context("U123", "D123", "private", undefined, TEAM_ID),
          catalog,
        ),
        {
          instruction: "Summarize new messages.",
          title: "Summarize DMs",
          outcomes: [],
          trigger: trigger(),
        },
      ),
    ).rejects.toThrow("not in a DM");

    // A temporary Watch cannot follow channel messages either.
    await expect(
      execute(createWatchEventsTool(channelContext, catalog), {
        namespace: "slack",
        identifier: "C123",
        resourceType: "channel",
        label: "New messages",
        events: ["message.posted"],
        intent: "Tell me about new messages.",
      }),
    ).rejects.toThrow("Use createEventAutomation");
  });
});
