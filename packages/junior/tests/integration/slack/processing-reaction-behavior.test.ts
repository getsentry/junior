import { describe, expect, it } from "vitest";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import {
  createModelAgentRunner,
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import { NO_REPLY_MARKER } from "@/chat/no-reply";
import { getConversationEventStore } from "@/chat/db";

function reactionCall(name: string, timestamp: string) {
  return expect.objectContaining({
    params: expect.objectContaining({
      channel: "C0PROCESSING",
      timestamp,
      name,
    }),
  });
}

describe("Slack behavior: processing reaction", () => {
  it("adds eyes before mention work and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunnerForRun(() => {
          expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
          expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
          return createModelStream([{ type: "text", text: "Done." }]);
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0PROCESSING:1700007000.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007001.000000",
        text: "<@U0APP> handle this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007001.000000",
          thread_ts: "1700007000.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
      reactionCall("white_check_mark", "1700007001.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007001.000000"),
    ]);
  });

  it("does not add eyes when a subscribed message is skipped", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              object: {
                should_reply: false,
                confidence: 0,
                reason: "side conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"side conversation"}',
            } as never;
          },
        },
        agentRunner: neverRunAgentRunner(),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0PROCESSING:1700007100.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007101.000000",
        text: "sounds good, thanks",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007101.000000",
          thread_ts: "1700007100.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts).toHaveLength(0);
    expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("adds eyes after a subscribed message is approved and marks the message complete after the reply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () => {
            expect(slackApiOutbox.reactionAdds()).toHaveLength(0);
            expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
            return {
              object: {
                should_reply: true,
                should_unsubscribe: false,
                confidence: 1,
                reason: "direct follow-up",
              },
              text: '{"should_reply":true,"should_unsubscribe":false,"confidence":1,"reason":"direct follow-up"}',
            } as never;
          },
        },
        agentRunner: createModelAgentRunnerForRun(() => {
          expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
          expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
          return createModelStream([{ type: "text", text: "Done." }]);
        }),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0PROCESSING:1700007150.000000",
    });
    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700007151.000000",
        text: "can you check this next?",
        isMention: false,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007151.000000",
          thread_ts: "1700007150.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
      reactionCall("white_check_mark", "1700007151.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007151.000000"),
    ]);
  });

  it("keeps eyes when the assistant explicitly adds an eyes reaction", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            {
              type: "toolCall",
              name: "addReaction",
              arguments: { emoji: ":eyes:" },
            },
            { type: "text", text: "Done." },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0PROCESSING:1700007200.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007201.000000",
        text: "<@U0APP> add eyes to this",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007201.000000",
          thread_ts: "1700007200.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007201.000000"),
      reactionCall("eyes", "1700007201.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toHaveLength(0);
  });

  it("clears eyes and marks complete for reaction-only no-reply turns", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        agentRunner: createModelAgentRunner(
          createModelStream([
            {
              type: "toolCall",
              name: "addReaction",
              arguments: { emoji: ":heart:" },
            },
            { type: "text", text: NO_REPLY_MARKER },
          ]),
        ),
      },
    });

    const thread = await createTestThread({
      id: "slack:C0PROCESSING:1700007300.000000",
    });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700007301.000000",
        text: "<@U0APP> give me a heart reaction",
        isMention: true,
        threadId: thread.id,
        raw: {
          channel: "C0PROCESSING",
          ts: "1700007301.000000",
          thread_ts: "1700007300.000000",
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(slackApiOutbox.reactionAdds()).toEqual([
      reactionCall("eyes", "1700007301.000000"),
      reactionCall("heart", "1700007301.000000"),
      reactionCall("white_check_mark", "1700007301.000000"),
    ]);
    expect(slackApiOutbox.reactionRemovals()).toEqual([
      reactionCall("eyes", "1700007301.000000"),
    ]);
    expect(thread.posts).toHaveLength(0);
    const lifecycleEvents = (
      await getConversationEventStore().loadHistory(thread.id)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycleEvents.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      outcome: "no_reply",
    });
  });
});
