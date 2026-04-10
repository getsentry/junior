import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

function toPostedText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") {
      return markdown;
    }
  }

  return String(value);
}

function makeDiagnostics(toolCalls: string[] = ["renderCard"]) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls,
    toolErrorCount: 0,
    toolResultCount: toolCalls.length,
    usedPrimaryText: true,
  };
}

describe("Slack behavior: rendered cards", () => {
  it("posts rendered cards after the text reply and records them in thread artifacts", async () => {
    const card = { type: "card", title: "Issue #42" } as never;
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Here is the latest issue state.",
            renderedCards: [
              {
                cardElement: card,
                entityKey: "github.issue:42",
                pluginName: "github",
                fallbackText: "#42: Issue title (open)",
              },
            ],
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_CARD:1700008000.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-card-1",
        text: "<@U_APP> show me issue 42",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value", "value"]);
    expect(toPostedText(thread.posts[0])).toBe(
      "Here is the latest issue state.",
    );
    expect(thread.posts[1]).toBe(card);
    expect(thread.getState()).toMatchObject({
      artifacts: {
        cardMessages: [
          {
            entityKey: "github.issue:42",
            messageId: "sent-2",
            pluginName: "github",
          },
        ],
      },
    });
  });

  it("updates an existing rendered card in place on a later turn", async () => {
    const firstCard = { type: "card", title: "Issue #42 open" } as never;
    const secondCard = { type: "card", title: "Issue #42 closed" } as never;
    let callCount = 0;

    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            callCount += 1;
            return {
              text: "",
              deliveryPlan: {
                mode: "thread",
                postThreadText: false,
                attachFiles: "none",
              },
              renderedCards: [
                {
                  cardElement: callCount === 1 ? firstCard : secondCard,
                  entityKey: "github.issue:42",
                  pluginName: "github",
                  fallbackText:
                    callCount === 1
                      ? "#42: Issue title (open)"
                      : "#42: Issue title (closed)",
                },
              ],
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_CARD:1700008001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-card-2a",
        text: "<@U_APP> show me issue 42",
        isMention: true,
        threadId: thread.id,
      }),
    );
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-card-2b",
        text: "<@U_APP> refresh issue 42",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.postKinds).toEqual(["value"]);
    expect(thread.posts).toEqual([secondCard]);
    expect(thread.getState()).toMatchObject({
      artifacts: {
        cardMessages: [
          {
            entityKey: "github.issue:42",
            messageId: "sent-1",
            pluginName: "github",
          },
        ],
      },
    });
  });
});
