import { describe, expect, it } from "vitest";
import { hasDashboardActivitySincePriorSlackMessage } from "@/chat/slack/dashboard-activity";
import { coerceThreadConversationState } from "@/chat/state/conversation";

function conversationWithMessages(
  messages: Array<{
    id: string;
    source?: "web";
    slackTs?: string;
  }>,
) {
  const conversation = coerceThreadConversationState({});
  conversation.messages = messages.map((message, index) => ({
    id: message.id,
    role: "user",
    text: message.id,
    createdAtMs: index,
    meta: {
      ...(message.source ? { source: message.source } : {}),
      ...(message.slackTs ? { slackTs: message.slackTs } : {}),
    },
  }));
  return conversation;
}

describe("hasDashboardActivitySincePriorSlackMessage", () => {
  it("finds web activity between the prior and current Slack messages", () => {
    expect(
      hasDashboardActivitySincePriorSlackMessage(
        conversationWithMessages([
          { id: "slack-before", slackTs: "1.000001" },
          { id: "web-user", source: "web" },
          { id: "web-assistant", source: "web" },
          { id: "slack-current", slackTs: "2.000001" },
        ]),
        "slack-current",
      ),
    ).toBe(true);
  });

  it("ignores web activity before the prior Slack message", () => {
    expect(
      hasDashboardActivitySincePriorSlackMessage(
        conversationWithMessages([
          { id: "web-old", source: "web" },
          { id: "slack-before", slackTs: "1.000001" },
          { id: "slack-current", slackTs: "2.000001" },
        ]),
        "slack-current",
      ),
    ).toBe(false);
  });
});
