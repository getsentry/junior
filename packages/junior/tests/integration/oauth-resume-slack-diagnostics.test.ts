import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOauthResumeSlackFixture,
  makeResumeDiagnostics,
} from "../fixtures/oauth-resume-slack";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

describe("oauth resume slack diagnostics", () => {
  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("uses cumulative session diagnostics for resumed reply footers", async () => {
    await testbed.turnSessionStore.upsertAgentTurnSessionRecord({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 2,
      state: "awaiting_resume",
      piMessages: [],
      resumeReason: "timeout",
      cumulativeDurationMs: 1_000,
      cumulativeUsage: {
        totalTokens: 1_000,
      },
    });

    await testbed.resumeAuthorizedRequest({
      messageText: "continue this turn",
      channelId: "C123",
      threadTs: "1700000000.007",
      connectedText: "",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        requester: { userId: "U123" },
        correlation: {
          conversationId: "conversation-1",
          turnId: "turn-1",
        },
      },
      generateReply: async () =>
        ({
          text: "done",
          diagnostics: makeResumeDiagnostics("success", {
            durationMs: 500,
            usage: {
              outputTokens: 7,
            },
          }),
        }) as any,
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.007",
          text: "done",
          blocks: [
            {
              type: "markdown",
              text: "done",
            },
            {
              type: "context",
              elements: expect.arrayContaining([
                {
                  type: "mrkdwn",
                  text: "*ID:* conversation-1",
                },
                {
                  type: "mrkdwn",
                  text: "*Tokens:* 1k",
                },
                {
                  type: "mrkdwn",
                  text: "*Time:* 1.5s",
                },
              ]),
            },
          ],
        }),
      }),
    ]);
  });
});
