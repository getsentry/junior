import { describe, expect, it } from "vitest";
import { resumeAuthorizedRequest } from "@/handlers/oauth-resume";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

describe("oauth resume slack integration", () => {
  it("posts resumed status updates through the Slack MSW harness", async () => {
    await resumeAuthorizedRequest({
      messageText: "What budget deadline did I mention earlier?",
      requesterUserId: "U123",
      provider: "eval-auth",
      channelId: "C123",
      threadTs: "1700000000.001",
      connectedText:
        "Your eval-auth MCP access is now connected. Continuing the original request...",
      failureText:
        "MCP authorization completed, but resuming the request failed. Please retry the original command.",
      generateReply: async () =>
        ({
          text: "The budget deadline you mentioned earlier was Friday.",
        }) as any,
    });

    expect(getCapturedSlackApiCalls("assistant.threads.setStatus")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.001",
          status: expect.any(String),
          loading_messages: [expect.any(String)],
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
          channel: "C123",
          thread_ts: "1700000000.001",
          text: "The budget deadline you mentioned earlier was Friday.",
        }),
      }),
    ]);
  });
});
