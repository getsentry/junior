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
import { juniorEventAutomations } from "@/db/schema/event-automations";
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

function trigger(identifier = "current_channel") {
  return {
    namespace: "slack",
    identifier,
    resourceType: "channel",
    label: "New messages in #discuss-integration",
    events: ["message.posted"],
  };
}

async function postChannelMessage(input: {
  channel?: string;
  threadTs?: string;
  ts: string;
}) {
  const state = getStateAdapter();
  await state.connect();
  const slackAdapter = createSlackAdapterFixture();
  return await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(
      slackEnvelope({
        eventType: "message",
        text: "How do I connect the Jira integration?",
        ...input,
      }),
    ),
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
      .delete(juniorEventAutomations)
      .where(eq(juniorEventAutomations.teamId, TEAM_ID));
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

    // A thread reply and a message in another channel do not run it.
    expect(
      (
        await postChannelMessage({
          threadTs: "1712345.0001",
          ts: "1712345.0002",
        })
      ).status,
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
        trigger: trigger("<#C999|secret-project>"),
      }),
    ).rejects.toThrow("can watch only the channel where it posts");

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
