import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { getCapturedSlackApiCalls } from "../../msw/handlers/slack-api";

function makeDiagnostics(toolCalls: string[] = ["renderCard"]) {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls,
    toolErrorCount: 0,
    toolResultCount: toolCalls.length,
    usedPrimaryText: false,
  };
}

function makeNativeCard(title: string) {
  return {
    entityKey: "sentry.issue:JUNIOR-1G",
    pluginName: "sentry",
    fallbackText: `JUNIOR-1G: ${title} (unresolved)`,
    slackMessage: {
      attachments: [
        {
          color: "#E01E5A",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*<https://sentry.example.com/issues/JUNIOR-1G|JUNIOR-1G>*\n${title}`,
              },
            },
          ],
        },
      ],
    },
  };
}

describe("Slack behavior: native rendered cards", () => {
  it("posts Slack-native rendered cards through chat.postMessage", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "",
            deliveryPlan: {
              mode: "thread",
              postThreadText: false,
              attachFiles: "none",
            },
            renderedCards: [
              makeNativeCard(
                "Error: An API error occurred: message_not_in_streaming_state",
              ),
            ],
            diagnostics: makeDiagnostics(),
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_NATIVE:1700009000.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-native-1",
        text: "<@U_APP> show me the most recent sentry issue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_NATIVE",
          thread_ts: "1700009000.000",
          attachments: [
            expect.objectContaining({
              color: "#E01E5A",
              blocks: [
                expect.objectContaining({
                  type: "section",
                }),
              ],
            }),
          ],
        }),
      }),
    ]);
    expect(thread.getState()).toMatchObject({
      artifacts: {
        cardMessages: [
          {
            entityKey: "sentry.issue:JUNIOR-1G",
            pluginName: "sentry",
            messageId: expect.stringMatching(/^slack:/),
            channelMessageTs: expect.any(String),
          },
        ],
      },
    });
  });

  it("updates Slack-native rendered cards in place through chat.update", async () => {
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
                makeNativeCard(
                  callCount === 1 ? "First issue title" : "Updated issue title",
                ),
              ],
              diagnostics: makeDiagnostics(),
            };
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_NATIVE:1700009001.000" });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-native-2a",
        text: "<@U_APP> show me the most recent sentry issue",
        isMention: true,
        threadId: thread.id,
      }),
    );
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "m-native-2b",
        text: "<@U_APP> refresh that sentry issue",
        isMention: true,
        threadId: thread.id,
      }),
    );

    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    expect(getCapturedSlackApiCalls("chat.update")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_NATIVE",
          ts: expect.any(String),
          attachments: [
            expect.objectContaining({
              blocks: [
                expect.objectContaining({
                  type: "section",
                  text: expect.objectContaining({
                    text: "*<https://sentry.example.com/issues/JUNIOR-1G|JUNIOR-1G>*\nUpdated issue title",
                  }),
                }),
              ],
            }),
          ],
        }),
      }),
    ]);
    expect(thread.getState()).toMatchObject({
      artifacts: {
        cardMessages: [
          {
            entityKey: "sentry.issue:JUNIOR-1G",
            pluginName: "sentry",
            messageId: expect.stringMatching(/^slack:/),
            channelMessageTs: expect.any(String),
          },
        ],
      },
    });
  });
});
