import type { AssistantThreadStartedEvent } from "@slack/types";
import { createMemoryState } from "@chat-adapter/state-memory";
import {
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackRuntime } from "@/chat/app/factory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

const DM_CHANNEL_ID = "D12345";
const DM_THREAD_TS = "1700000100.000100";

describe("Slack contract: assistant lifecycle delivery", () => {
  beforeEach(() => {
    resetSlackApiMockState();
  });

  afterEach(() => {
    resetSlackApiMockState();
  });

  it("normalizes adapter-scoped channel ids before assistant lifecycle API calls", async () => {
    const slack = createJuniorSlackAdapter({
      botToken: "xoxb-test",
      botUserId: "U0BOT",
      signingSecret: "test-signing-secret",
    });
    const slackRuntime = createSlackRuntime({
      getSlackAdapter: () => slack,
    });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: `slack:${DM_CHANNEL_ID}:${DM_THREAD_TS}`,
      channelId: `slack:${DM_CHANNEL_ID}`,
      threadTs: DM_THREAD_TS,
      userId: "U0TEST",
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setTitle")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: DM_THREAD_TS,
          title: "Junior",
        }),
      }),
    ]);
    expect(
      getCapturedSlackApiCalls("assistant.threads.setSuggestedPrompts"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: DM_CHANNEL_ID,
          thread_ts: DM_THREAD_TS,
          prompts: expect.arrayContaining([
            expect.objectContaining({
              title: "Summarize thread",
            }),
          ]),
        }),
      }),
    ]);
  });

  it("validates assistant callbacks and preserves the title on context changes", async () => {
    const slack = createSlackAdapterFixture();
    const state = createMemoryState();
    const queue = createConversationWorkQueueTestAdapter();
    const services = {
      getSlackAdapter: () => slack,
      state,
      queue,
      runtime: createSlackRuntime({ getSlackAdapter: () => slack }),
    };
    const event = {
      type: "assistant_thread_started",
      event_ts: DM_THREAD_TS,
      assistant_thread: {
        channel_id: DM_CHANNEL_ID,
        thread_ts: DM_THREAD_TS,
        user_id: "U0TEST",
        context: { channel_id: "C123", enterprise_id: null },
      },
    } satisfies AssistantThreadStartedEvent;
    for (const callback of [
      {
        ...event,
        assistant_thread: { ...event.assistant_thread, thread_ts: 123 },
      },
      event,
      { ...event, type: "assistant_thread_context_changed" },
    ]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({
          type: "event_callback",
          team_id: "T123",
          event: callback,
        }),
        services,
      });
      expect(response.status).toBe(200);
    }
    expect(getCapturedSlackApiCalls("assistant.threads.setTitle")).toHaveLength(
      1,
    );
    expect(
      getCapturedSlackApiCalls("assistant.threads.setSuggestedPrompts"),
    ).toHaveLength(2);
    expect(queue.queuedMessages()).toEqual([]);
    await state.disconnect();
  });
});
