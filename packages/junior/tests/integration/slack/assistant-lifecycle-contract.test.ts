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
      botUserId: "U_BOT",
      signingSecret: "test-signing-secret",
    });
    const slackRuntime = createSlackRuntime({
      getSlackAdapter: () => slack,
    });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: `slack:${DM_CHANNEL_ID}:${DM_THREAD_TS}`,
      channelId: `slack:${DM_CHANNEL_ID}`,
      threadTs: DM_THREAD_TS,
      userId: "U_TEST",
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
});
