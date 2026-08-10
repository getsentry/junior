import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { persistConversationMessages } from "@/chat/conversations/messages";
import { deliverAssistantMessagesForTest } from "../../fixtures/agent-runner";

const { postMessageMock, setStatusMock, uploadFilesToThreadMock } = vi.hoisted(
  () => ({
    postMessageMock: vi.fn(),
    setStatusMock: vi.fn(),
    uploadFilesToThreadMock: vi.fn(),
  }),
);

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/slack/client", () => ({
  SlackActionError: class SlackActionError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.name = "SlackActionError";
      this.code = code;
    }
  },
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: async (task: () => Promise<unknown>) => await task(),
  getSlackClient: () => ({
    chat: {
      postMessage: postMessageMock,
    },
    assistant: {
      threads: {
        setStatus: setStatusMock,
      },
    },
  }),
}));

vi.mock("@/chat/slack/outbound", () => ({
  postSlackMessage: async (input: {
    blocks?: unknown[];
    channelId: string;
    text: string;
    threadTs?: string;
  }) =>
    await postMessageMock({
      channel: input.channelId,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.blocks ? { blocks: input.blocks } : {}),
    }),
  uploadFilesToThread: uploadFilesToThreadMock,
}));

import { resumeSlackTurn } from "@/chat/runtime/slack-resume";

const TEST_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T-test",
  channelId: "C-test",
} as const;

function testSlackSource(threadTs: string) {
  return createSlackSource({
    teamId: TEST_SLACK_DESTINATION.teamId,
    channelId: TEST_SLACK_DESTINATION.channelId,
    threadTs,

    visibility: "private",
  });
}

async function seedResumedTurn(threadTs: string) {
  const visibleConversationId = `slack:C-test:${threadTs}`;
  const conversationId = `slack:T-test:C-test:${threadTs}`;
  const userMessageId = threadTs;
  const conversation = coerceThreadConversationState({});
  conversation.messages.push({
    id: userMessageId,
    role: "user",
    text: "continue this turn",
    createdAtMs: 1,
    author: { userId: "U-test", userName: "test" },
    meta: { slackTs: threadTs },
  });
  await persistThreadStateById(visibleConversationId, { conversation });
  await persistConversationMessages({ conversation, conversationId });
  return {
    conversationId,
    turnId: buildDeterministicTurnId(userMessageId),
    visibleConversationId,
  };
}

describe("resumeSlackTurn", () => {
  beforeEach(async () => {
    postMessageMock.mockReset();
    setStatusMock.mockReset();
    uploadFilesToThreadMock.mockReset();
    postMessageMock.mockResolvedValue({ ts: "1700000000.100" });
    setStatusMock.mockResolvedValue(undefined);
    uploadFilesToThreadMock.mockResolvedValue(undefined);
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    setPlugins([]);
    await disconnectStateAdapter();
  });

  it("persists failure state before posting the failure reply", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "tell me the saved deadline",
      conversationId: "slack:C-test:1700000000.0004",
      turnId: "turn-failure",
      channelId: "C-test",
      threadTs: "1700000000.0004",
      initialText: "connected",
      replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.0004"),
          actor: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      agentRunner: {
        run: async () => {
          throw new Error("resume failed");
        },
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: "connected",
      }),
    );
    expect(postMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0004",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
      }),
    );
  });

  it("does not post a failure reply when completion persistence fails after final delivery", async () => {
    const onFailure = vi.fn(async () => undefined);
    const resumed = await seedResumedTurn("1700000000.0005");

    await expect(
      resumeSlackTurn({
        messageText: "continue this turn",
        conversationId: "slack:T-test:C-test:1700000000.0005",
        turnId: resumed.turnId,
        channelId: "C-test",
        threadTs: "1700000000.0005",
        replyContext: {
            credentialContext: {
              actor: { type: "user", userId: "U-test" },
            },
            destination: TEST_SLACK_DESTINATION,
            source: testSlackSource("1700000000.0005"),
            actor: {
              platform: "slack",
              teamId: "T-test",
              userId: "U-test",
            },
        },
        agentRunner: {
          run: async (request) => {
            await deliverAssistantMessagesForTest(request, [
              { text: "Final resumed answer" },
            ]);
            return completedAgentRun({
              text: "Final resumed answer",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "fake-agent-model",
                outcome: "success" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            });
          },
        },
        commitResult: async () => {
          throw new Error("state write failed");
        },
        onFailure,
      }),
    ).rejects.toThrow("state write failed");

    expect(onFailure).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0005",
        text: expect.stringContaining("Final resumed answer"),
      }),
    );
    expect(postMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0005",
        text: expect.stringContaining(
          "I ran into an internal error while processing that.",
        ),
      }),
    );
  });

  it("schedules plugin tasks after a successful resumed turn", async () => {
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);
    const resumed = await seedResumedTurn("1700000000.0006");

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:T-test:C-test:1700000000.0006",
      turnId: resumed.turnId,
      channelId: "C-test",
      threadTs: "1700000000.0006",
      replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.0006"),
          actor: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      agentRunner: {
        run: async (request) => {
          await deliverAssistantMessagesForTest(request, [
            { text: "Final resumed answer" },
          ]);
          return completedAgentRun({
            text: "Final resumed answer",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "fake-agent-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          });
        },
      },
      scheduleSessionCompletedPluginTasks,
    });

    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: "slack:T-test:C-test:1700000000.0006",
      sessionId: resumed.turnId,
    });
  });

  it("releases the thread lock before scheduling a continuation", async () => {
    const onSuspend = vi.fn(async () => {
      const stateAdapter = getStateAdapter();
      await stateAdapter.connect();
      const lock = await stateAdapter.acquireLock(
        "slack:C-test:1700000000.0002",
        60_000,
      );
      expect(lock).not.toBeNull();
      if (lock) {
        await stateAdapter.releaseLock(lock);
      }
    });

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:C-test:1700000000.0002",
      turnId: "turn-timeout-pause",
      channelId: "C-test",
      threadTs: "1700000000.0002",
      replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.0002"),
          actor: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      agentRunner: {
        run: async () => ({
          status: "suspended" as const,
          resumeVersion: 3,
        }),
      },
      onSuspend,
    });

    expect(onSuspend).toHaveBeenCalledOnce();
    expect(onSuspend).toHaveBeenCalledWith(3);
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("runs failure handling when suspension handling throws", async () => {
    const onFailure = vi.fn(async () => undefined);

    await resumeSlackTurn({
      messageText: "continue this turn",
      conversationId: "slack:C-test:1700000000.0003",
      turnId: "turn-timeout-pause-failure",
      channelId: "C-test",
      threadTs: "1700000000.0003",
      replyContext: {
          credentialContext: {
            actor: { type: "user", userId: "U-test" },
          },
          destination: TEST_SLACK_DESTINATION,
          source: testSlackSource("1700000000.0003"),
          actor: { platform: "slack", teamId: "T-test", userId: "U-test" },
      },
      agentRunner: {
        run: async () => ({
          status: "suspended" as const,
          resumeVersion: 3,
        }),
      },
      onSuspend: async () => {
        throw new Error("continuation scheduling failed");
      },
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-test",
        thread_ts: "1700000000.0003",
        text: expect.stringContaining(
          "I ran into an internal error while processing that. Reference: `event_id=",
        ),
      }),
    );
  });
});
