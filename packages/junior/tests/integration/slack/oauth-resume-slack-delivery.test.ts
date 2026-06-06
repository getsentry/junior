import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOauthResumeSlackFixture } from "../../fixtures/oauth-resume-slack";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

describe("oauth resume slack delivery", () => {
  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("posts resumed status updates through the Slack MSW harness", async () => {
    await testbed.resumeAuthorizedRequest({
      messageText: "What budget deadline did I mention earlier?",
      channelId: "C123",
      threadTs: "1700000000.001",
      connectedText:
        "Your eval-auth MCP access is now connected. Continuing the original request...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        requester: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      generateReply: async () =>
        successfulAssistantReply(
          "The budget deadline you mentioned earlier was Friday.",
        ),
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.001",
          status: expect.any(String),
          loading_messages: expect.arrayContaining([expect.any(String)]),
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.001",
          status: "",
        }),
      }),
    ]);

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "Your eval-auth MCP access is now connected. Continuing the original request...",
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          blocks: [
            {
              type: "markdown",
              text: "The budget deadline you mentioned earlier was Friday.",
            },
            {
              type: "context",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  type: "mrkdwn",
                  text: expect.stringContaining(
                    "*ID:* slack:C123:1700000000.001",
                  ),
                }),
              ]),
            },
          ],
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "The budget deadline you mentioned earlier was Friday.",
        }),
      }),
    ]);
  }, 10_000);
});
