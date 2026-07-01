import { beforeEach, describe, expect, it } from "vitest";
import { runWithSlackInstallationToken } from "@/chat/slack/client";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

describe("Slack contract: outbound installation token", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    resetSlackApiMockState();
  });

  it("posts with the ambient destination installation token when bound", async () => {
    await runWithSlackInstallationToken(
      "xoxb-destination-workspace-token",
      () =>
        postSlackMessage({
          channelId: "slack:C123",
          text: "hello from another workspace",
        }),
    );

    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe(
      "Bearer xoxb-destination-workspace-token",
    );
  });

  it("posts with the env bot token when no installation token is bound", async () => {
    await postSlackMessage({
      channelId: "slack:C123",
      text: "hello from the default workspace",
    });

    const calls = getCapturedSlackApiCalls("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe("Bearer xoxb-test-token");
  });
});
