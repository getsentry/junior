import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSlackInterruptionMarker } from "@/chat/slack/output";
import {
  createOauthResumeSlackFixture,
  makeResumeDiagnostics,
} from "../../fixtures/oauth-resume-slack";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { TEST_SLACK_DESTINATION } from "../../fixtures/reply-context";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthResumeSlackFixture>>;

describe("oauth resume slack failure markers", () => {
  beforeEach(async () => {
    testbed = await createOauthResumeSlackFixture();
  });

  afterEach(async () => {
    await testbed.cleanup();
  });

  it("marks resumed provider-error partial replies as interrupted", async () => {
    await testbed.resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.003",
      connectedText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      generateReply: async () =>
        successfulAssistantReply("Partial output", {
          diagnostics: makeResumeDiagnostics("provider_error"),
        }),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.003",
    });
    expect(postCalls[1]?.params.text).toContain("Partial output");
    expect(postCalls[1]?.params.text).toContain(
      getSlackInterruptionMarker().trim(),
    );
    expect(postCalls[1]?.params.text).not.toContain("event_id=");
  });

  it("replaces resumed execution-failure replies before Slack planning", async () => {
    await testbed.resumeAuthorizedRequest({
      messageText: "Continue the original request",
      channelId: "C123",
      threadTs: "1700000000.006",
      connectedText: "Connected. Continuing...",
      replyContext: {
        credentialContext: {
          actor: { type: "user", userId: "U123" },
        },
        destination: TEST_SLACK_DESTINATION,
        requester: { platform: "slack", teamId: "T123", userId: "U123" },
      },
      generateReply: async () =>
        successfulAssistantReply("", {
          diagnostics: makeResumeDiagnostics("execution_failure", {
            assistantMessageCount: 0,
            usedPrimaryText: false,
          }),
        }),
    });

    const postCalls = getCapturedSlackApiCalls("chat.postMessage");
    expect(postCalls).toHaveLength(2);
    expect(postCalls[1]?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1700000000.006",
    });
    expect(postCalls[1]?.params.text).toContain(
      "I ran into an internal error while processing that. Reference: `event_id=",
    );
  });
});
