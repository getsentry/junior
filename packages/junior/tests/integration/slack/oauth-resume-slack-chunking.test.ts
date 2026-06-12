import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSlackContinuationMarker } from "@/chat/slack/output";
import {
  createOauthResumeSlackFixture,
  makeResumeDiagnostics,
} from "../../fixtures/oauth-resume-slack";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { TEST_SLACK_DESTINATION } from "../../fixtures/reply-context";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

describe("oauth resume slack chunking", () => {
  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("chunks long resumed replies into explicit continuation messages", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");

    await testbed.resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.002",
      connectedText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      generateReply: async () =>
        successfulAssistantReply(longReply, {
          diagnostics: makeResumeDiagnostics(),
        }),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(5);
    expect(postCalls[0]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.002",
      text: "Connected. Continuing...",
    });
    expect(postCalls[1]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[2]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[3]?.params.text).toContain(getSlackContinuationMarker());
    expect(postCalls[4]?.params.text).not.toContain(
      getSlackContinuationMarker(),
    );
    expect(postCalls[4]?.params.text).toContain("line 80");
  });
});
