import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackBotToken } from "@/chat/config";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  conversation,
  PULL_REQUEST_REVIEW_WAKES,
  ROOT,
  wakeOnPullRequestReview,
} from "../../../fixtures/snoozes";

// With no Slack bot token, Event publishing resolves no Slack team. The
// config reads the token when it loads, so remove it before any import.
vi.hoisted(() => {
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_USER_TOKEN;
});

describe("snoozes without a Slack team", () => {
  let fixture: ConversationFixture;

  beforeEach(async () => {
    fixture = await createConversationFixture();
    await conversation(ROOT, "public");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeConversationFixture();
  });

  it("wakes a snooze on a GitHub Event when no Slack team resolves", async () => {
    expect(getSlackBotToken()).toBeUndefined();
    expect(await wakeOnPullRequestReview(fixture)).toEqual(
      PULL_REQUEST_REVIEW_WAKES,
    );
  });
});
