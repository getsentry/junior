import { afterEach, describe, expect, it } from "vitest";
import {
  pauseConversationDelivery,
  resumeConversationDelivery,
} from "@/chat/conversations/delivery-pause";
import { closeDb, getConversationStore } from "@/chat/db";
import { getConversationStoppedAtMs } from "@/chat/conversations/stop-state";
import { stopAtAutomatedTurnLimit } from "@/chat/slack/automated-turn-limit-notice";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

const conversationId = "slack:C123:1700000000.100";

describe("automated-turn limit notice", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  it("stops the Conversation and posts no notice in a detached thread", async () => {
    await getConversationStore().recordActivity({
      conversationId,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
        threadTs: "1700000000.100",
      },
      nowMs: Date.parse("2026-08-12T17:00:00.000Z"),
      source: "slack",
      title: "Watched pull request",
      visibility: "private",
    });
    await pauseConversationDelivery(conversationId);

    const reached = { consecutiveAutomatedTurns: 3, reached: true };
    await stopAtAutomatedTurnLimit({
      conversationId,
      maxTurns: 3,
      update: reached,
    });
    await expect(getConversationStoppedAtMs(conversationId)).resolves.toEqual(
      expect.any(Number),
    );
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);

    await resumeConversationDelivery(conversationId);
    await stopAtAutomatedTurnLimit({
      conversationId,
      maxTurns: 3,
      update: reached,
    });
    expect(
      getCapturedSlackApiCalls("chat.postMessage")[0]?.params,
    ).toMatchObject({ channel: "C123", thread_ts: "1700000000.100" });
  });
});
